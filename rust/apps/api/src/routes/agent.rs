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

use app_core::AgentEvent;
use domain::{NodeId, TopicId};

use crate::error::ApiError;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct ProposeRequest {
  pub topic_id: TopicId,
  #[serde(default)]
  pub focused_node_id: Option<NodeId>,
  pub prompt: String,
}

pub async fn status(State(svc): State<AppState>) -> Json<serde_json::Value> {
  Json(json!({
    "backend": svc.agent_backend(),
  }))
}

pub async fn propose(
  State(svc): State<AppState>,
  Json(body): Json<ProposeRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
  let inner = svc
    .propose(&body.topic_id, body.focused_node_id, body.prompt)
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
