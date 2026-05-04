//! `/v1/topics` and `/v1/topics/:id` routes.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;

use domain::{NewTopic, NodeId, NodeType, Timestamp, Topic, TopicId, TopicSummary};

use crate::error::ApiError;
use crate::AppState;

/// Per-node summary returned alongside `Topic` from `GET /v1/topics/:id`.
/// Excludes `content` so the response stays small; clients fetch full
/// nodes lazily via `GET /v1/nodes/:id`.
#[derive(Debug, Serialize)]
pub struct NodeSummary {
  pub id: NodeId,
  pub parent: Option<NodeId>,
  #[serde(rename = "type")]
  pub node_type: NodeType,
  pub title: String,
  pub links: Vec<NodeId>,
  pub updated_at: Timestamp,
}

#[derive(Debug, Serialize)]
pub struct TopicDetail {
  #[serde(flatten)]
  pub topic: Topic,
  pub nodes: Vec<NodeSummary>,
}

pub async fn list(State(svc): State<AppState>) -> Result<Json<Vec<TopicSummary>>, ApiError> {
  Ok(Json(svc.list_topics().await?))
}

pub async fn create(
  State(svc): State<AppState>,
  Json(new): Json<NewTopic>,
) -> Result<(StatusCode, Json<Topic>), ApiError> {
  let topic = svc.create_topic(new).await?;
  Ok((StatusCode::CREATED, Json(topic)))
}

pub async fn get(
  State(svc): State<AppState>,
  Path(id): Path<TopicId>,
) -> Result<Json<TopicDetail>, ApiError> {
  let topic = svc.get_topic(&id).await?;
  let nodes = svc.list_nodes_in_topic(&id).await?;
  let summaries = nodes
    .into_iter()
    .map(|n| NodeSummary {
      id: n.id,
      parent: n.parent,
      node_type: n.node_type,
      title: n.title,
      links: n.links,
      updated_at: n.updated_at,
    })
    .collect();
  Ok(Json(TopicDetail {
    topic,
    nodes: summaries,
  }))
}

pub async fn delete(
  State(svc): State<AppState>,
  Path(id): Path<TopicId>,
) -> Result<StatusCode, ApiError> {
  svc.delete_topic(&id).await?;
  Ok(StatusCode::NO_CONTENT)
}
