//! `GET /v1/index/status` and `POST /v1/index/rebuild`.
//!
//! Rebuild is intentionally synchronous (await-blocks the request) for
//! P1; for large vaults P4 will swap in a background job + progress SSE.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;

use domain::IndexStatus;

use crate::error::ApiError;
use crate::AppState;

pub async fn status(State(svc): State<AppState>) -> Result<Json<IndexStatus>, ApiError> {
  Ok(Json(svc.index_status().await?))
}

pub async fn rebuild(State(svc): State<AppState>) -> Result<StatusCode, ApiError> {
  svc.rebuild_index().await?;
  Ok(StatusCode::NO_CONTENT)
}
