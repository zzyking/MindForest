//! Hybrid search composition — FTS + vector arms fused via Reciprocal
//! Rank Fusion. The FTS arm always runs; the vec arm runs iff the
//! embedder reports itself available.
//!
//! Failure semantics for the vec arm — both classes degrade to FTS-only
//! (failing the whole search over a broken vec arm would be worse), but
//! they are deliberately NOT logged alike:
//!
//! - **embed() fails** (sidecar dies between `available()` and the
//!   call): routine availability race → `warn!`.
//! - **search_vec() fails** (dimension mismatch, corrupt vec table):
//!   never routine — this is the "semantic search quietly stopped
//!   working" class of bug → `error!`. A debug-level log here once hid
//!   a real defect for weeks.

use std::collections::HashMap;

use domain::{ForestResult, NodeId, SearchHit, TopicId};

use crate::ForestService;

impl ForestService {
  /// Hybrid search. Always runs FTS; runs vec in parallel iff the
  /// embedder is available. Results are fused via Reciprocal Rank Fusion
  /// (k_rrf=60) — robust without per-feature score normalization, and
  /// well-studied as a hybrid baseline.
  pub async fn search(
    &self,
    query: &str,
    topic: Option<&TopicId>,
    k: usize,
  ) -> ForestResult<Vec<SearchHit>> {
    if !self.embedder.available() {
      return self.index.search_fts(query, topic, k).await;
    }
    // Over-fetch on each side so the fusion has room to elevate
    // candidates that show up near-but-not-top in either ranking.
    let candidate_k = (k * 2).max(10);
    let q_str = query.to_string();
    let topic_owned = topic.cloned();

    // Borrow-friendly closures so both branches can reference self.
    let fts_fut = async {
      self
        .index
        .search_fts(&q_str, topic_owned.as_ref(), candidate_k)
        .await
    };
    // The vec arm is infallible from the caller's perspective — every
    // failure degrades to an empty contribution — but the two failure
    // classes log at different levels (see module docs).
    let vec_fut = async {
      let mut embed_out = match self.embedder.embed(std::slice::from_ref(&q_str)).await {
        Ok(v) => v,
        Err(e) => {
          tracing::warn!("search: query embed failed, serving FTS-only this request: {e}");
          return Vec::new();
        }
      };
      let Some(q_vec) = embed_out.pop() else {
        tracing::warn!("search: embedder returned no vector for query, serving FTS-only");
        return Vec::new();
      };
      match self
        .index
        .search_vec(&q_vec, topic_owned.as_ref(), candidate_k)
        .await
      {
        Ok(hits) => hits,
        Err(e) => {
          tracing::error!(
            "search: vec index query failed (dimension mismatch or corrupt vec table?), \
             results are FTS-only until fixed: {e}"
          );
          Vec::new()
        }
      }
    };

    let (fts_res, vec_hits) = tokio::join!(fts_fut, vec_fut);
    let fts_hits = fts_res?;

    Ok(fuse_rrf(fts_hits, vec_hits, k))
  }
}

/// Standard RRF: each ranking contributes `1 / (k_rrf + rank)` per id;
/// final score is the sum across rankings. The constant 60 is the value
/// recommended by Cormack et al. and commonly used elsewhere; it's
/// robust enough that we don't expose it as a knob.
fn fuse_rrf(
  fts: Vec<SearchHit>,
  vec: Vec<SearchHit>,
  k: usize,
) -> Vec<SearchHit> {
  const K_RRF: f32 = 60.0;
  let mut scores: HashMap<NodeId, f32> = HashMap::new();
  let mut details: HashMap<NodeId, SearchHit> = HashMap::new();

  let push = |hits: Vec<SearchHit>,
              scores: &mut HashMap<NodeId, f32>,
              details: &mut HashMap<NodeId, SearchHit>| {
    for (rank, hit) in hits.into_iter().enumerate() {
      *scores.entry(hit.id).or_insert(0.0) += 1.0 / (K_RRF + rank as f32 + 1.0);
      // Prefer the FTS detail (it has the highlighted snippet); the vec
      // arm fills in `snippet=""`, so an existing entry never gets
      // downgraded by being overwritten with vec data.
      details.entry(hit.id).or_insert(hit);
    }
  };
  push(fts, &mut scores, &mut details);
  push(vec, &mut scores, &mut details);

  let mut entries: Vec<(NodeId, f32)> = scores.into_iter().collect();
  entries.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
  entries
    .into_iter()
    .take(k)
    .filter_map(|(id, score)| {
      details.remove(&id).map(|mut h| {
        h.score = score;
        h
      })
    })
    .collect()
}
