//! `embed` — `Embedder` implementations.
//!
//! Three concrete strategies, all implementing the `domain::Embedder`
//! trait so the rest of the system doesn't need to know which one is in
//! play:
//!
//! - **`StubEmbedder`** — deterministic, normalized 768-dim vectors derived
//!   from a blake3 hash of the input. Reports as available so the sqlite-vec
//!   write path can be exercised without a real model. Identical text →
//!   identical vector; different text → effectively orthogonal vectors.
//!   Use this in tests, in `npm run dev` against a fresh vault, and as a
//!   fallback while the user is downloading the real MLX model.
//!
//! - **`SidecarEmbedder`** — spawns the Swift `mindforest-embed` binary
//!   that loads MLX-Swift + EmbeddingGemma 4-bit. stdio newline-JSON
//!   protocol with request-id matching; a single supervisor task owns
//!   the child process and reaps + restarts it on crash with 1s/4s/16s
//!   exponential backoff. After 3 consecutive failures the supervisor
//!   gives up and the embedder reports unavailable.
//!
//! - **`UnavailableEmbedder`** — always errors with `EmbedUnavailable`.
//!   Used on platforms (Intel Mac, Linux, Windows) where the sidecar
//!   isn't shipped, and in `MINDFOREST_EMBED_MODE=off`.
//!
//! Selection happens once at app-core bootstrap via `EmbedMode`. The
//! choice is observable: `Embedder::available()` flips `IndexStatus`'s
//! `embed_available` flag the frontend reads.

pub mod download;
pub mod sidecar;
pub mod stub;
pub mod unavailable;

use std::path::PathBuf;
use std::sync::Arc;

pub use domain::Embedder;
pub use sidecar::SidecarEmbedder;
pub use stub::StubEmbedder;
pub use unavailable::UnavailableEmbedder;

/// Embedder selector — picked at app-core bootstrap from env or config.
#[derive(Debug, Clone)]
pub enum EmbedMode {
  /// No embedder; hybrid search degrades to FTS-only. Default on
  /// platforms where the sidecar binary isn't shipped.
  Off,
  /// Deterministic stub. Matches the wire shape of a real embedder so
  /// sqlite-vec is exercised end-to-end, but vectors are not semantic.
  Stub,
  /// MLX-Swift sidecar at the given path. The supervisor task takes over
  /// once the embedder is constructed; failures and restarts are logged
  /// but never propagated back as errors — `available()` reflects health.
  Sidecar { binary: PathBuf },
}

impl EmbedMode {
  /// Resolve from `MINDFOREST_EMBED_MODE` env. Accepts `off`/`stub`/`sidecar`.
  /// `sidecar` requires `MINDFOREST_EMBED_BIN` to point at the binary.
  /// Default: `Off` on non-Apple-Silicon builds, `Stub` everywhere else.
  pub fn from_env() -> Self {
    let raw = std::env::var("MINDFOREST_EMBED_MODE").ok();
    match raw.as_deref() {
      Some("off") => Self::Off,
      Some("stub") => Self::Stub,
      Some("sidecar") => match std::env::var("MINDFOREST_EMBED_BIN") {
        Ok(p) => Self::Sidecar { binary: p.into() },
        Err(_) => {
          tracing::warn!(
            "MINDFOREST_EMBED_MODE=sidecar but MINDFOREST_EMBED_BIN unset — falling back to stub"
          );
          Self::Stub
        }
      },
      _ => default_mode(),
    }
  }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn default_mode() -> EmbedMode {
  // The sidecar binary lands in P3 (Swift package). Until it's bundled
  // into Tauri's Resources we keep the default off Apple Silicon to the
  // stub so the rest of the system is exercised; production builds set
  // `MINDFOREST_EMBED_MODE=sidecar` explicitly.
  EmbedMode::Stub
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn default_mode() -> EmbedMode {
  EmbedMode::Off
}

/// Build an embedder for the requested mode. Returns an `Arc<dyn Embedder>`
/// since the supervisor task may outlive any single caller and we want
/// cheap clones across `app-core` services.
///
/// `model_dir` is only consulted by the sidecar path and is forwarded
/// to the child as `MINDFOREST_MODEL_DIR`; the Swift binary uses it to
/// pick MLX inference over its stub. Other modes ignore the argument.
pub fn build_embedder(mode: EmbedMode, model_dir: Option<PathBuf>) -> Arc<dyn Embedder> {
  match mode {
    EmbedMode::Off => Arc::new(UnavailableEmbedder::new(domain_dim())),
    EmbedMode::Stub => Arc::new(StubEmbedder::new(domain_dim())),
    EmbedMode::Sidecar { binary } => {
      Arc::new(SidecarEmbedder::spawn(binary, domain_dim(), model_dir))
    }
  }
}

/// Default embedding dimension — kept here rather than re-exposed from
/// index-sqlite to keep the dependency direction one-way (app-core → both).
pub const fn domain_dim() -> usize {
  768
}
