//! `POST /v1/agent/propose` — SSE stream of agent reply events.
//! `GET  /v1/agent/status`  — backend label + capability flag.
//!
//! Same SSE convention as the model download endpoint: each frame has
//! an `event:` name (variant snake_case) and a JSON `data:` payload, plus
//! a 15s `: keepalive` heartbeat to keep idle proxies from hanging up.
//!
//! The body shape mirrors the agent crate's `AgentRequest` minus the
//! topic + node list (which we hydrate server-side from `topic_id` —
//! the client doesn't need to ship the full graph back to us).

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures::stream::{Stream, StreamExt};
use serde::Deserialize;
use serde_json::json;

use app_core::{AgentConfig, AgentEvent, AgentTurn};
use domain::{NodeId, TopicId};

use crate::error::ApiError;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct ProposeRequest {
  pub topic_id: TopicId,
  #[serde(default)]
  pub focused_node_id: Option<NodeId>,
  pub prompt: String,
  /// Prior conversation turns, oldest first. Empty for a fresh chat.
  /// Each turn is `{ role: "user" | "assistant", text }`.
  #[serde(default)]
  pub history: Vec<AgentTurn>,
}

pub async fn status(State(svc): State<AppState>) -> Json<serde_json::Value> {
  Json(json!({
    "backend": svc.agent_backend().await,
  }))
}

/// `GET /v1/agent/config` — current persisted agent settings, including
/// API keys verbatim. Loopback-only; the frontend reflects this into a
/// settings panel.
pub async fn get_config(State(svc): State<AppState>) -> Json<AgentConfig> {
  Json(svc.agent_config().await)
}

/// `PUT /v1/agent/config` — write new agent settings to disk and rebuild
/// the proposer in place. Returns the post-write backend label so the
/// UI can update its "powered by …" hint without a separate fetch.
pub async fn put_config(
  State(svc): State<AppState>,
  Json(body): Json<AgentConfig>,
) -> Result<Json<serde_json::Value>, ApiError> {
  let backend = svc.set_agent_config(body).await?;
  Ok(Json(json!({ "backend": backend })))
}

pub async fn propose(
  State(svc): State<AppState>,
  Json(body): Json<ProposeRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
  let inner = svc
    .propose(
      &body.topic_id,
      body.focused_node_id,
      body.prompt,
      body.history,
    )
    .await?;
  let stream = inner.map(|ev| {
    let name = event_name(&ev);
    // serde_json::to_string is infallible for AgentEvent (pure data).
    // Defensive fallback keeps the SSE channel alive on the cosmic-ray
    // case where it isn't.
    let data = serde_json::to_string(&ev)
      .unwrap_or_else(|e| format!(r#"{{"kind":"error","message":"serialize: {e}"}}"#));
    Ok::<_, Infallible>(Event::default().event(name).data(data))
  });
  Ok(
    Sse::new(stream).keep_alive(
      KeepAlive::new()
        .interval(Duration::from_secs(15))
        .text("keepalive"),
    ),
  )
}

fn event_name(ev: &AgentEvent) -> &'static str {
  match ev {
    AgentEvent::Token { .. } => "token",
    AgentEvent::Proposal { .. } => "proposal",
    AgentEvent::Error { .. } => "error",
    AgentEvent::Done => "done",
  }
}
