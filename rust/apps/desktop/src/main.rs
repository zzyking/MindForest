#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! MindForest desktop shell.
//!
//! Boots the axum API in-process on an OS-assigned localhost port,
//! injects the resulting base URL into the webview via an initialization
//! script (`window.__MINDFOREST_API_BASE__`), and lets the SPA hit it
//! over plain HTTP. SSE flows the same way — no separate IPC layer.
//!
//! Vault path resolution order:
//!   1. `MINDFOREST_VAULT` env var (escape hatch for tests / power users)
//!   2. `<app_data_dir>/vault` (per-OS conventional location)
//!   3. fail with a useful message
//!
//! Data path resolution order (derived state — sqlite index + MLX models):
//!   1. `MINDFOREST_DATA_DIR` env var (escape hatch — symmetric with vault)
//!   2. `<app_data_dir>/.mindforest` (peer to vault, *not* nested inside it
//!      — see `app_core::bootstrap` for why)
//!
//! Embed sidecar resolution:
//!   - If `MINDFOREST_EMBED_BIN` is already set we leave it alone.
//!   - Packaged builds: look beside the desktop binary inside the
//!     `.app/Contents/MacOS/` directory (`current_exe()` parent +
//!     `mindforest-embed`). Tauri's `bundle.externalBin` lands the
//!     Swift-built sidecar there at packaging time; the colocated
//!     `mlx.metallib` lives in the same directory because mlx-swift
//!     loads its Metal kernels by binary-relative path.
//!   - Dev builds: look in the workspace at
//!     `apps/embed-sidecar/.build/<triple>/{release,debug}/mindforest-embed`,
//!     which is what `swift build` produces locally.
//!   When found we set both `MINDFOREST_EMBED_BIN` and
//!   `MINDFOREST_EMBED_MODE=sidecar` so the API picks it up at boot.
//!   When not found we leave env alone — `EmbedMode::from_env()` falls
//!   through to its platform default (Stub on Apple Silicon, Off
//!   elsewhere).

use std::path::PathBuf;

use api::serve_with_listener;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

fn main() {
  init_tracing();

  tauri::Builder::default()
    .setup(|app| {
      let vault_dir = resolve_vault_dir(app)?;
      let data_dir = resolve_data_dir(app)?;
      warn_if_legacy_data_dir(&vault_dir, &data_dir);
      configure_embed_sidecar();

      // Bind synchronously so the OS-assigned port is known before the
      // webview is created — the init script depends on it. Using
      // std::net::TcpListener here and converting to tokio inside the
      // async task avoids needing a runtime context at this point.
      let std_listener = std::net::TcpListener::bind("127.0.0.1:0")?;
      std_listener.set_nonblocking(true)?;
      let local_addr = std_listener.local_addr()?;
      let api_base = format!("http://{local_addr}");
      tracing::info!(
        "api will listen on {api_base} (vault={}, data={})",
        vault_dir.display(),
        data_dir.display()
      );

      // Programmatic window creation. We don't declare a window in
      // tauri.conf.json because the initialization script — which carries
      // the dynamically-chosen port — must be set on the WebviewBuilder
      // *before* the window starts loading content. Auto-created windows
      // would race the script.
      let init_script = format!(
        r#"
        window.__MINDFOREST_API_BASE__ = "{base}";
        "#,
        // Defensively escape — `base` is built from a SocketAddr so it's
        // already URL-shaped, but we still strip quotes / backslashes to
        // make the injection robust against any future config drift.
        base = api_base.replace(['"', '\\'], ""),
      );

      // Dev vs release window URL. `cargo tauri dev` builds in debug,
      // `cargo tauri build` in release; `debug_assertions` is the
      // standard proxy for that distinction. The dev URL string mirrors
      // `tauri.conf.json::build.devUrl` — we duplicate the constant
      // because the programmatic builder doesn't pick it up implicitly.
      let url = if cfg!(debug_assertions) {
        WebviewUrl::External(
          "http://localhost:13000"
            .parse()
            .expect("devUrl should be a valid URL"),
        )
      } else {
        WebviewUrl::App("index.html".into())
      };

      // WKWebView background — keep it matched to `--color-forest-50` in
      // `web/src/styles/tokens.css` so any 1-frame WKWebView lag during
      // a resize doesn't expose a contrasting color underneath. Keep
      // both this value and the NSWindow fix below in lockstep with
      // tokens.css.
      // `TitleBarStyle::Overlay` removes the system titlebar entirely;
      // traffic lights float at top-left and the WKWebView content
      // extends to the very top of the window. `hidden_title(true)`
      // suppresses the window title text that would otherwise sit
      // alongside the lights.
      //
      // We deliberately leave NSWindow.backgroundColor at its system
      // default — see `feedback_wkwebview_rendering.md` memory note.
      // The drag affordance is restored by a `data-tauri-drag-region`
      // strip at the top of `WorkspaceShell` (requires the
      // `core:window:allow-start-dragging` permission in
      // `capabilities/default.json`).
      WebviewWindowBuilder::new(app, "main", url)
        .title("MindForest")
        .inner_size(1280.0, 800.0)
        .min_inner_size(640.0, 480.0)
        .resizable(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .initialization_script(&init_script)
        .build()?;

      // Open devtools opt-in for headless debug sessions.
      if std::env::var("TAURI_DEVTOOLS").as_deref() == Ok("1") {
        if let Some(win) = app.get_webview_window("main") {
          win.open_devtools();
        }
      }

      // Hand the std listener to tokio + spawn the API future on Tauri's
      // shared runtime. We do conversion inside the async block so we
      // don't need a runtime context here (`set_nonblocking(true)` above
      // is what makes `from_std` legal).
      tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
          Ok(l) => l,
          Err(e) => {
            tracing::error!("failed to convert std listener: {e}");
            return;
          }
        };
        if let Err(e) = serve_with_listener(listener, vault_dir, data_dir).await {
          tracing::error!("api serve failed: {e}");
        }
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

/// If `MINDFOREST_EMBED_BIN` is unset, try to point it at a freshly
/// `swift build`-d sidecar binary in the workspace. Idempotent — if
/// the user already set the env we don't override.
///
/// We resolve via `CARGO_MANIFEST_DIR` so the path is correct regardless
/// of where `cargo tauri dev` is invoked from. macOS-only because the
/// sidecar is only built on Apple Silicon (per design).
fn configure_embed_sidecar() {
  if std::env::var_os("MINDFOREST_EMBED_BIN").is_some() {
    // Caller has chosen a binary path explicitly — respect it.
    return;
  }
  let Some(path) = resolve_sidecar_binary() else {
    tracing::debug!("embed sidecar binary not found in workspace; falling back to mode=stub/off");
    return;
  };
  tracing::info!("embed sidecar resolved at {}", path.display());
  std::env::set_var("MINDFOREST_EMBED_BIN", &path);
  if std::env::var_os("MINDFOREST_EMBED_MODE").is_none() {
    std::env::set_var("MINDFOREST_EMBED_MODE", "sidecar");
  }
}

#[cfg(target_os = "macos")]
fn resolve_sidecar_binary() -> Option<PathBuf> {
  // Packaged builds: the Tauri bundler copies our externalBin entries
  // into Contents/MacOS/ alongside the desktop binary itself. Look
  // there first — if it exists, that's authoritative and we should
  // not fall through to the workspace path (which won't exist on an
  // end-user machine anyway).
  if let Ok(exe) = std::env::current_exe() {
    if let Some(dir) = exe.parent() {
      let candidate = dir.join("mindforest-embed");
      if candidate.exists() {
        return Some(candidate);
      }
    }
  }

  // Dev builds: resolve out of the workspace `swift build` output.
  // Map Rust's `target_arch` to Swift Package Manager's build-output
  // directory naming (Rust uses `aarch64`, Swift uses `arm64`).
  let triple = if cfg!(target_arch = "aarch64") {
    "arm64-apple-macosx"
  } else if cfg!(target_arch = "x86_64") {
    "x86_64-apple-macosx"
  } else {
    return None;
  };
  let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .parent() // apps/
    .and_then(|p| p.parent())
    .map(|p| p.to_path_buf())?;
  let base = workspace_root.join("apps/embed-sidecar/.build").join(triple);
  // Prefer release over debug — release is what we'd ship; if the user
  // hasn't built either, neither path exists.
  for flavor in ["release", "debug"] {
    let candidate = base.join(flavor).join("mindforest-embed");
    if candidate.exists() {
      return Some(candidate);
    }
  }
  None
}

#[cfg(not(target_os = "macos"))]
fn resolve_sidecar_binary() -> Option<PathBuf> {
  None
}

fn resolve_vault_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
  if let Ok(p) = std::env::var("MINDFOREST_VAULT") {
    return Ok(PathBuf::from(p));
  }
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("could not resolve app_data_dir: {e}"))?
    .join("vault");
  // Eagerly create — `FsRepository::open` will too, but doing it here
  // surfaces permission errors before the webview has spun up.
  std::fs::create_dir_all(&dir)
    .map_err(|e| format!("could not create vault dir {}: {e}", dir.display()))?;
  Ok(dir)
}

/// Derived-state directory — sqlite index + downloaded MLX model
/// weights. Sibling to vault, never nested inside it. The split lets
/// the user put the vault under iCloud / Dropbox without dragging
/// regenerable artifacts (which can total hundreds of MB) along.
fn resolve_data_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
  if let Ok(p) = std::env::var("MINDFOREST_DATA_DIR") {
    return Ok(PathBuf::from(p));
  }
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("could not resolve app_data_dir: {e}"))?
    .join(".mindforest");
  std::fs::create_dir_all(&dir)
    .map_err(|e| format!("could not create data dir {}: {e}", dir.display()))?;
  Ok(dir)
}

/// Refactor/v2 changed the layout from `<vault>/.mindforest` to
/// `<app_data>/.mindforest` — a peer of vault, not a child. This
/// function logs a one-line hint when the legacy directory exists but
/// the new one is empty, so a returning user understands why their
/// index will be rebuilt from markdown on first launch. Removable in a
/// follow-up commit once we're past the refactor branch.
fn warn_if_legacy_data_dir(vault_dir: &std::path::Path, data_dir: &std::path::Path) {
  let legacy = vault_dir.join(".mindforest").join("index.db");
  let current = data_dir.join("index.db");
  if legacy.exists() && !current.exists() {
    tracing::warn!(
      "legacy derived-state dir found at {}; the index will be rebuilt at {} on first launch — \
       you can delete the legacy directory once the rebuild completes",
      legacy.parent().unwrap_or(&legacy).display(),
      data_dir.display()
    );
  }
}

fn init_tracing() {
  let filter =
    std::env::var("RUST_LOG").unwrap_or_else(|_| "info,api=info,app_core=info".to_string());
  // `try_init` so packaged builds don't panic if tracing was already
  // initialized by something upstream (e.g. a future plugin).
  let _ = tracing_subscriber::registry()
    .with(tracing_subscriber::EnvFilter::new(filter))
    .with(tracing_subscriber::fmt::layer())
    .try_init();
}
