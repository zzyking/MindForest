use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Clone)]
pub struct ApiConfig {
  pub addr: SocketAddr,
  pub vault_dir: Option<PathBuf>,
}

impl Default for ApiConfig {
  fn default() -> Self {
    Self {
      addr: SocketAddr::from(([127, 0, 0, 1], 8787)),
      vault_dir: None,
    }
  }
}

pub async fn run(config: ApiConfig) -> Result<(), Box<dyn std::error::Error>> {
  tracing::warn!(
    "api::run is a v2 placeholder; routes land in Phase 1 task #6 (addr={}, vault={:?})",
    config.addr,
    config.vault_dir
  );
  Ok(())
}
