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
//! Sidecar resolution (P3) will live here too; left as a TODO.

use std::path::PathBuf;

use api::serve_with_listener;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

fn main() {
  init_tracing();

  tauri::Builder::default()
    .setup(|app| {
      let vault_dir = resolve_vault_dir(app)?;

      // Bind synchronously so the OS-assigned port is known before the
      // webview is created — the init script depends on it. Using
      // std::net::TcpListener here and converting to tokio inside the
      // async task avoids needing a runtime context at this point.
      let std_listener = std::net::TcpListener::bind("127.0.0.1:0")?;
      std_listener.set_nonblocking(true)?;
      let local_addr = std_listener.local_addr()?;
      let api_base = format!("http://{local_addr}");
      tracing::info!("api will listen on {api_base} (vault={})", vault_dir.display());

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

      WebviewWindowBuilder::new(app, "main", url)
        .title("MindForest")
        .inner_size(1280.0, 800.0)
        .resizable(true)
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
        if let Err(e) = serve_with_listener(listener, vault_dir).await {
          tracing::error!("api serve failed: {e}");
        }
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
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
