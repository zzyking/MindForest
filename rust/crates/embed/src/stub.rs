//! Deterministic stub embedder.
//!
//! Maps a text to a unit-norm `Vec<f32>` via blake3's extendable output:
//! we ask blake3 for `dim*4` bytes, reinterpret each 4-byte chunk as a
//! little-endian u32, project to `[-1, 1]`, then normalize. Identical
//! text produces identical vectors; different texts produce vectors that
//! are effectively orthogonal under cosine distance.
//!
//! This is "fake but consistent" — useful when we need the sqlite-vec
//! pipeline exercised but don't have (or don't want) a real model.

use async_trait::async_trait;

use domain::{Embedder, ForestResult};

pub struct StubEmbedder {
  dim: usize,
}

impl StubEmbedder {
  pub fn new(dim: usize) -> Self {
    Self { dim }
  }
}

#[async_trait]
impl Embedder for StubEmbedder {
  async fn embed(&self, texts: &[String]) -> ForestResult<Vec<Vec<f32>>> {
    Ok(texts.iter().map(|t| stub_vector(t, self.dim)).collect())
  }

  fn dim(&self) -> usize {
    self.dim
  }

  fn available(&self) -> bool {
    true
  }
}

fn stub_vector(text: &str, dim: usize) -> Vec<f32> {
  let mut hasher = blake3::Hasher::new();
  hasher.update(text.as_bytes());
  let mut bytes = vec![0u8; dim * 4];
  hasher.finalize_xof().fill(&mut bytes);

  let mut v: Vec<f32> = bytes
    .chunks_exact(4)
    .map(|c| {
      let u = u32::from_le_bytes([c[0], c[1], c[2], c[3]]);
      // Map u32 to f32 in [-1, 1).
      (u as f32 / u32::MAX as f32) * 2.0 - 1.0
    })
    .collect();

  let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
  if norm > 0.0 {
    for x in &mut v {
      *x /= norm;
    }
  }
  v
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn deterministic_for_same_input() {
    let e = StubEmbedder::new(768);
    let a = e.embed(&["hello".into()]).await.unwrap();
    let b = e.embed(&["hello".into()]).await.unwrap();
    assert_eq!(a, b);
  }

  #[tokio::test]
  async fn different_inputs_produce_different_vectors() {
    let e = StubEmbedder::new(768);
    let a = e.embed(&["hello".into()]).await.unwrap();
    let b = e.embed(&["world".into()]).await.unwrap();
    assert_ne!(a[0], b[0]);
  }

  #[tokio::test]
  async fn output_is_unit_norm() {
    let e = StubEmbedder::new(768);
    let v = e.embed(&["arbitrary text".into()]).await.unwrap();
    let norm = v[0].iter().map(|x| x * x).sum::<f32>().sqrt();
    assert!((norm - 1.0).abs() < 1e-4, "norm should be ~1, got {norm}");
  }

  #[tokio::test]
  async fn batch_preserves_order() {
    let e = StubEmbedder::new(768);
    let v = e.embed(&["a".into(), "b".into(), "c".into()]).await.unwrap();
    assert_eq!(v.len(), 3);
    let only_a = e.embed(&["a".into()]).await.unwrap();
    assert_eq!(v[0], only_a[0]);
  }

  #[tokio::test]
  async fn dim_matches() {
    let e = StubEmbedder::new(768);
    let v = e.embed(&["x".into()]).await.unwrap();
    assert_eq!(v[0].len(), 768);
    assert_eq!(e.dim(), 768);
  }
}
