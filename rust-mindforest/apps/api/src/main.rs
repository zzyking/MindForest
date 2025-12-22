use std::net::SocketAddr;

use api::{run, ApiConfig};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
  init_tracing();

  let addr: SocketAddr = std::env::var("API_ADDR")
    .unwrap_or_else(|_| "127.0.0.1:8787".to_string())
    .parse()?;

  let config = ApiConfig {
    addr,
    database_url: std::env::var("DATABASE_URL").ok(),
    static_dir: std::env::var("STATIC_DIR").ok().map(Into::into),
  };

  run(config).await
}

fn init_tracing() {
  let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "info,axum=info".to_string());
  tracing_subscriber::registry()
    .with(tracing_subscriber::EnvFilter::new(filter))
    .with(tracing_subscriber::fmt::layer())
    .init();
}
