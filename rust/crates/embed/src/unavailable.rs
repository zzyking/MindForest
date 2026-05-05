//! No-op embedder. Always returns `EmbedUnavailable`. Hybrid search at
//! the app-core layer notices `available() == false` and skips the
//! vector arm of the query, so the system stays usable without an
//! embedder.

use async_trait::async_trait;

use domain::{Embedder, ForestError, ForestResult};

pub struct UnavailableEmbedder {
  dim: usize,
}

impl UnavailableEmbedder {
  pub fn new(dim: usize) -> Self {
    Self { dim }
  }
}

#[async_trait]
impl Embedder for UnavailableEmbedder {
  async fn embed(&self, _texts: &[String]) -> ForestResult<Vec<Vec<f32>>> {
    Err(ForestError::EmbedUnavailable)
  }

  fn dim(&self) -> usize {
    self.dim
  }

  fn available(&self) -> bool {
    false
  }
}
