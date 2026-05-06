//! Standalone dev binary. Tauri does not use this; it calls `api::run`
//! directly from inside the desktop process.
//!
//! Env:
//!   API_ADDR             listen address (default 127.0.0.1:8787)
//!   MINDFOREST_VAULT     vault root directory (required)
//!   MINDFOREST_DATA_DIR  derived-state dir (default `<vault>/.mindforest`,
//!                        keeps `cargo run -p api` working with no extra
//!                        config; production callers — i.e. the Tauri
//!                        shell — set this explicitly to a peer of vault)
//!   RUST_LOG             tracing filter (default "info,axum=info,tower_http=info")

use std::net::SocketAddr;
use std::path::PathBuf;

use api::{run, ApiConfig};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
  init_tracing();

  let addr: SocketAddr = std::env::var("API_ADDR")
    .unwrap_or_else(|_| "127.0.0.1:8787".to_string())
    .parse()?;

  let vault_dir: PathBuf = std::env::var("MINDFOREST_VAULT")
    .map_err(|_| "MINDFOREST_VAULT must be set when running the dev binary directly")?
    .into();

  let data_dir: PathBuf = std::env::var("MINDFOREST_DATA_DIR")
    .map(PathBuf::from)
    .unwrap_or_else(|_| vault_dir.join(".mindforest"));

  run(ApiConfig {
    addr,
    vault_dir,
    data_dir,
  })
  .await
}

fn init_tracing() {
  let filter =
    std::env::var("RUST_LOG").unwrap_or_else(|_| "info,axum=info,tower_http=info".to_string());
  tracing_subscriber::registry()
    .with(tracing_subscriber::EnvFilter::new(filter))
    .with(tracing_subscriber::fmt::layer())
    .init();
}
