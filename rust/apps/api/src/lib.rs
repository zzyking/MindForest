//! HTTP surface for MindForest.
//!
//! Wraps `app_core::ForestService` in an axum router. The same router is
//! served by the standalone binary (`main.rs`) for dev curl-ing and
//! mounted in-process by `apps/desktop` so Tauri webviews can reach the
//! same endpoints over `127.0.0.1:<port>` without spawning a separate
//! process.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use app_core::{bootstrap, Bootstrap, EmbedMode, ForestService};

pub mod error;
pub mod routes;

/// Shared axum state. `Arc<ForestService>` is itself cheap to clone and
/// already internally reference-counts the repo + index.
pub type AppState = Arc<ForestService>;

#[derive(Clone)]
pub struct ApiConfig {
  pub addr: SocketAddr,
  /// User markdown root. Source-of-truth.
  pub vault_dir: PathBuf,
  /// App-owned derived state — sqlite index, downloaded MLX models.
  /// Peer to vault, not nested inside it (see `bootstrap` rationale).
  pub data_dir: PathBuf,
}

impl ApiConfig {
  pub fn new(vault_dir: PathBuf, data_dir: PathBuf) -> Self {
    Self {
      addr: SocketAddr::from(([127, 0, 0, 1], 8787)),
      vault_dir,
      data_dir,
    }
  }
}

/// Build the axum `Router` over a pre-wired service. Useful for tests
/// (with an in-memory index) and for desktop embedding where bootstrap
/// is owned by the host.
pub fn router(state: AppState) -> Router {
  Router::new()
    .route("/health", axum::routing::get(routes::health))
    .nest("/v1", routes::v1())
    .layer(CorsLayer::permissive())
    .layer(TraceLayer::new_for_http())
    .with_state(state)
}

/// Bootstrap a `ForestService` against `config.vault_dir` +
/// `config.data_dir`, spawn the watcher loop, bind axum on
/// `config.addr`, and serve until the future is cancelled. The
/// watcher's debouncer is held alive by this function's stack until
/// the server shuts down — see `Bootstrap` docs.
pub async fn run(config: ApiConfig) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
  let listener = tokio::net::TcpListener::bind(config.addr).await?;
  serve_with_listener(listener, config.vault_dir, config.data_dir).await
}

/// Same as `run`, but takes a pre-bound `TcpListener`. The Tauri shell
/// uses this so it can bind `127.0.0.1:0`, observe the OS-assigned port
/// *before* serving starts, and inject the resulting URL into the
/// webview via an initialization script — avoiding the dev-server
/// port-collision footgun and the need for a fixed well-known port.
///
/// `vault_dir` is the user's markdown root; `data_dir` is the app-owned
/// directory for derived state (sqlite index, MLX model weights). They
/// are deliberately decoupled — see `app_core::bootstrap` rationale.
///
/// The embed mode is read from `MINDFOREST_EMBED_MODE` (see
/// `embed::EmbedMode::from_env`) — `off` / `stub` / `sidecar`.
pub async fn serve_with_listener(
  listener: tokio::net::TcpListener,
  vault_dir: PathBuf,
  data_dir: PathBuf,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
  let local_addr = listener.local_addr()?;
  let embed_mode = EmbedMode::from_env();

  let Bootstrap { service, watcher } =
    bootstrap(vault_dir.clone(), data_dir.clone(), embed_mode).await?;
  // Partial-moving `watcher.events` leaves the private `_debouncer` field
  // bound to `watcher` until end of scope; that's what keeps the notify
  // watcher running for the lifetime of `axum::serve` below.
  service.clone().spawn_watcher(watcher.events);
  service.clone().spawn_embed_worker();

  let app = router(service);
  tracing::info!(
    "api listening on {} (vault={}, data={})",
    local_addr,
    vault_dir.display(),
    data_dir.display()
  );
  axum::serve(listener, app).await?;
  Ok(())
}
