//! HTTP error mapping for `ForestError`.
//!
//! `ApiError` is a thin newtype that lets handlers `?` through service
//! errors directly. Mapping to status codes is centralized here so route
//! files stay focused on shape.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use domain::ForestError;

#[derive(Debug)]
pub struct ApiError(pub ForestError);

impl From<ForestError> for ApiError {
  fn from(e: ForestError) -> Self {
    Self(e)
  }
}

impl IntoResponse for ApiError {
  fn into_response(self) -> Response {
    let (status, code) = match &self.0 {
      ForestError::TopicNotFound(_) | ForestError::NodeNotFound(_) => {
        (StatusCode::NOT_FOUND, "not_found")
      }
      ForestError::TopicAlreadyExists(_) => (StatusCode::CONFLICT, "conflict"),
      ForestError::InvalidInput(_) => (StatusCode::BAD_REQUEST, "invalid_input"),
      ForestError::EmbedUnavailable => (StatusCode::SERVICE_UNAVAILABLE, "embed_unavailable"),
      // Upstream-failure-shaped errors (Claude, sidecar) — distinct from
      // our own internal failures so clients can branch on retry policy.
      ForestError::Embed(_) | ForestError::Agent(_) => (StatusCode::BAD_GATEWAY, "upstream_error"),
      ForestError::Storage(_) | ForestError::Index(_) => {
        (StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
      }
    };
    if matches!(status, StatusCode::INTERNAL_SERVER_ERROR) {
      tracing::error!(error = %self.0, "api internal error");
    }
    let body = json!({
      "error": code,
      "message": self.0.to_string(),
    });
    (status, Json(body)).into_response()
  }
}
