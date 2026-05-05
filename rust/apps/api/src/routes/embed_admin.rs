//! `GET /v1/embed/model/status` — quick local snapshot.
//! `POST /v1/embed/model/download` — SSE stream of the HuggingFace pull.
//!
//! The download endpoint follows the same SSE convention as the agent
//! routes (P3b) will: each event has an `event:` name (variant snake-case)
//! and a JSON `data:` payload. A 15s `: keepalive` heartbeat keeps
//! intermediate proxies from idling-out the connection on slow networks.
//!
//! Cancellation: the client just closes the connection. The mpsc sender
//! inside the download task gets dropped; `bytes_stream().next()` returns
//! `None` on the next chunk and the supervisor exits cleanly. No explicit
//! cancel endpoint needed.

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures::stream::{Stream, StreamExt};

use app_core::{DownloadEvent, ModelStatusResponse};

use crate::error::ApiError;
use crate::AppState;

pub async fn status(
  State(svc): State<AppState>,
) -> Result<Json<ModelStatusResponse>, ApiError> {
  Ok(Json(svc.model_status().await?))
}

pub async fn download(
  State(svc): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
  // ForestService::download_model returns a `'static` stream owned by a
  // detached tokio task, so we don't need to hold svc alive here.
  let inner = svc.download_model();
  let stream = inner.map(|ev| {
    let name = event_name(&ev);
    // serde_json::to_string is infallible for our event types — they're
    // all simple structs / enums. Fall back to a sensible error event
    // if it ever fails so the SSE channel doesn't go silent.
    let data = serde_json::to_string(&ev)
      .unwrap_or_else(|e| format!(r#"{{"kind":"error","message":"serialize: {e}"}}"#));
    Ok::<_, Infallible>(Event::default().event(name).data(data))
  });
  Sse::new(stream).keep_alive(
    KeepAlive::new()
      .interval(Duration::from_secs(15))
      .text("keepalive"),
  )
}

fn event_name(ev: &DownloadEvent) -> &'static str {
  match ev {
    DownloadEvent::Started { .. } => "started",
    DownloadEvent::FileStart { .. } => "file_start",
    DownloadEvent::Progress { .. } => "progress",
    DownloadEvent::FileDone { .. } => "file_done",
    DownloadEvent::Done => "done",
    DownloadEvent::Error { .. } => "error",
  }
}
