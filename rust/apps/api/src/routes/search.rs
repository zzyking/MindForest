//! `GET /v1/search?q=...&topic=...&k=...`.
//!
//! P1: FTS only (delegates to `ForestService::search`). P3 will fuse
//! FTS + vector + topic-bonus reranking inside the service; this handler
//! stays unchanged.

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;

use domain::{SearchHit, TopicId};

use crate::error::ApiError;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct SearchParams {
  pub q: String,
  /// Optional topic filter. Same slug constraints as `TopicId` apply.
  pub topic: Option<TopicId>,
  /// Result cap. Defaults to 20; clamped to 100 to keep responses bounded.
  pub k: Option<usize>,
}

pub async fn search(
  State(svc): State<AppState>,
  Query(params): Query<SearchParams>,
) -> Result<Json<Vec<SearchHit>>, ApiError> {
  let k = params.k.unwrap_or(20).clamp(1, 100);
  let hits = svc.search(&params.q, params.topic.as_ref(), k).await?;
  Ok(Json(hits))
}
