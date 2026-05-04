#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{net::SocketAddr, path::PathBuf};

use api::{run, ApiConfig};
use tauri::Manager;

// v2 placeholder. Real wiring (CSP tightening, vault path resolution,
// embed-sidecar spawn) lands in Phase 1 task #5.
fn main() {
  tauri::Builder::default()
    .setup(|app| {
      let handle = app.handle();
      if std::env::var("TAURI_DEVTOOLS").as_deref() == Ok("1") {
        if let Some(win) = handle.get_webview_window("main") {
          win.open_devtools();
        }
      }

      let addr: SocketAddr = std::env::var("API_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8787".to_string())
        .parse()
        .expect("Invalid API_ADDR");

      let vault_dir: PathBuf = std::env::var("MINDFOREST_VAULT")
        .ok()
        .map(PathBuf::from)
        .or_else(|| app.path().app_data_dir().ok().map(|d| d.join("vault")))
        .expect("could not resolve a vault directory: set MINDFOREST_VAULT or run inside Tauri so app_data_dir is available");

      let config = ApiConfig { addr, vault_dir };

      tauri::async_runtime::spawn(async move {
        if let Err(err) = run(config).await {
          eprintln!("API failed: {err}");
        }
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
