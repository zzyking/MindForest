//! Embedding-model lifecycle — local presence checks and the download
//! stream for the EmbeddingGemma weights the MLX sidecar consumes.

use std::path::PathBuf;

use futures::Stream;

use domain::ForestResult;
use embed::download::{DownloadEvent, FileStatus};
use embed::EmbedMode;

use crate::ForestService;

/// The model the sidecar's MLX path expects. Hardcoded to keep the API
/// surface narrow — the frontend never picks a model. If we ever need
/// alternates we'll add a registry here.
pub const EMBEDDING_MODEL_REPO: &str = "mlx-community/embeddinggemma-300m-4bit";

/// Files we treat as "required" for the local model directory to be
/// considered ready. EmbeddingGemma 300M 4-bit is small enough to fit
/// in a single safetensors shard, so no `model-00001-of-N.safetensors`
/// pattern needed. If the upstream switches to sharding, the download
/// path still pulls everything; this list just gates the `present` flag.
pub const EMBEDDING_MODEL_FILES: &[&str] = &[
  "config.json",
  "model.safetensors",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
];

/// HTTP-shaped model status reply — wraps `ModelStatus` with the local
/// embed-mode label so the frontend can decide whether to surface the
/// download UI at all.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ModelStatusResponse {
  pub repo_id: String,
  pub dir: PathBuf,
  pub present: bool,
  pub files: Vec<FileStatus>,
  /// `"off"` / `"stub"` / `"sidecar"` — the user-visible name of the
  /// embedder backend currently in play.
  pub embed_mode: String,
}

pub(crate) fn embed_mode_label(mode: &EmbedMode) -> String {
  match mode {
    EmbedMode::Off => "off".into(),
    EmbedMode::Stub => "stub".into(),
    EmbedMode::Sidecar { .. } => "sidecar".into(),
  }
}

impl ForestService {
  /// Local snapshot of the EmbeddingGemma weights — does the model
  /// directory contain every file we expect to hand to the sidecar?
  /// Augmented with the embedder mode so the frontend can decide
  /// whether the download UI is even relevant.
  pub async fn model_status(&self) -> ForestResult<ModelStatusResponse> {
    let local = self
      .downloader
      .local_status(EMBEDDING_MODEL_REPO, EMBEDDING_MODEL_FILES)
      .await?;
    Ok(ModelStatusResponse {
      repo_id: local.repo_id,
      dir: local.dir,
      present: local.present,
      files: local.files,
      embed_mode: self.embed_mode_label.clone(),
    })
  }

  /// Stream the EmbeddingGemma download. Each event is emitted exactly
  /// once and the stream ends after `Done` (or `Error`). Caller is the
  /// HTTP handler that turns events into SSE frames.
  pub fn download_model(&self) -> impl Stream<Item = DownloadEvent> + Send + 'static {
    self.downloader.download(EMBEDDING_MODEL_REPO.to_string())
  }
}
