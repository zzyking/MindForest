#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, net::SocketAddr, path::PathBuf};

use api::{run, ApiConfig};
use tauri::Manager;

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      let handle = app.handle();
      if std::env::var("TAURI_DEVTOOLS").as_deref() == Ok("1") {
        if let Some(win) = handle.get_webview_window("main") {
          win.open_devtools();
        }
      }
      // Resolve API listen address (overridable via API_ADDR)
      let addr: SocketAddr = std::env::var("API_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8787".to_string())
        .parse()
        .expect("Invalid API_ADDR");

      // Resolve SQLite path, defaulting to a writable app data dir with a fallback
      let handle = app.handle();
      let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| resolve_sqlite_url(&handle));

      let config = ApiConfig {
        addr,
        database_url: Some(database_url),
        static_dir: None,
      };

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

fn resolve_sqlite_url(app: &tauri::AppHandle) -> String {
  let mut candidates: Vec<PathBuf> = Vec::new();

  if let Ok(app_dir) = app.path().app_data_dir() {
    candidates.push(app_dir);
  }

  if let Ok(home) = std::env::var("HOME") {
    candidates.push(PathBuf::from(home.clone()).join(".mindforest-data"));
    candidates.push(PathBuf::from(home).join("Library/Application Support/com.mindforest.desktop"));
  }

  for base in candidates {
    if let Err(err) = fs::create_dir_all(&base) {
      eprintln!("Failed to prepare database dir {:?}: {}", base, err);
      continue;
    }

    let db_path = base.join("mindforest.db");
    if let Err(err) = fs::OpenOptions::new()
      .create(true)
      .write(true)
      .open(&db_path)
    {
      eprintln!("Failed to touch database file {:?}: {}", db_path, err);
      continue;
    }

    let url = format!("sqlite://{}", db_path.to_string_lossy());
    println!("Using local SQLite at {} (fs path: {})", url, db_path.display());
    return url;
  }

  println!("Falling back to in-memory SQLite");
  "sqlite::memory:".to_string()
}
