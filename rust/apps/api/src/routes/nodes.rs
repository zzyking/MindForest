//! `/v1/nodes` and `/v1/nodes/:id` routes.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;

use domain::{NewNode, Node, NodeId, NodePatch};

use crate::error::ApiError;
use crate::AppState;

pub async fn create(
  State(svc): State<AppState>,
  Json(new): Json<NewNode>,
) -> Result<(StatusCode, Json<Node>), ApiError> {
  let node = svc.create_node(new).await?;
  Ok((StatusCode::CREATED, Json(node)))
}

pub async fn get(
  State(svc): State<AppState>,
  Path(id): Path<NodeId>,
) -> Result<Json<Node>, ApiError> {
  Ok(Json(svc.get_node(&id).await?))
}

pub async fn update(
  State(svc): State<AppState>,
  Path(id): Path<NodeId>,
  Json(patch): Json<NodePatch>,
) -> Result<Json<Node>, ApiError> {
  Ok(Json(svc.update_node(&id, patch).await?))
}

pub async fn delete(
  State(svc): State<AppState>,
  Path(id): Path<NodeId>,
) -> Result<StatusCode, ApiError> {
  svc.delete_node(&id).await?;
  Ok(StatusCode::NO_CONTENT)
}
