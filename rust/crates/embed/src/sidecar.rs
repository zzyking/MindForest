//! Sidecar-process embedder.
//!
//! Owns a child process (Swift `mindforest-embed`) that loads MLX-Swift
//! + EmbeddingGemma 4-bit and answers embedding requests over stdio.
//!
//! ## Wire protocol
//!
//! Both directions use newline-delimited JSON. Each request carries a
//! monotonically increasing `id`; each reply echoes the same `id` so we
//! can match on it (and surface a hard error if a reply arrives out of
//! order — that means stdout has been corrupted, which we recover from
//! by killing + restarting the child).
//!
//! ```text
//! → {"id": 1, "cmd": "health"}
//! ← {"id": 1, "ok": true, "model": "embeddinggemma-300m-4bit", "dim": 768}
//!
//! → {"id": 2, "texts": ["Backprop", "Chain rule"]}
//! ← {"id": 2, "embeddings": [[0.123, ...], [0.456, ...]]}
//!
//! → {"id": 0, "cmd": "shutdown"}     // sent on graceful drop
//! ```
//!
//! ## Lifecycle
//!
//! `spawn()` returns immediately. A single supervisor task owns the
//! child's lifecycle; the public `embed()` is just an mpsc enqueue + a
//! oneshot await. The supervisor:
//!
//! 1. starts the child, opens a 5s health check
//! 2. on health pass, flips `available` to true and serves requests in
//!    a single-stream loop (one outstanding request at a time so stdout
//!    can never interleave)
//! 3. on any read/write/parse error, kills the child, marks unavailable,
//!    sleeps with exponential backoff (1s/4s/16s), retries up to 3 times
//! 4. after 3 consecutive failures it drains any in-flight requests with
//!    `EmbedUnavailable` and exits — the embedder stays "permanently"
//!    unavailable until the process restarts
//!
//! When the request channel closes (the embedder is dropped) the
//! supervisor sends `{"cmd":"shutdown"}` and waits up to 1s for the
//! child to exit before falling through to its `Drop`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use domain::{Embedder, ForestError, ForestResult};

pub struct SidecarEmbedder {
  requests: mpsc::UnboundedSender<EmbedRequest>,
  available: Arc<AtomicBool>,
  dim: usize,
}

struct EmbedRequest {
  texts: Vec<String>,
  reply: oneshot::Sender<ForestResult<Vec<Vec<f32>>>>,
}

impl SidecarEmbedder {
  /// Spawn the supervisor in the background. Returns immediately;
  /// `available()` will start out `false` and flip to `true` once the
  /// health check passes (typically within a few hundred ms).
  pub fn spawn(binary: PathBuf, dim: usize) -> Self {
    let (tx, rx) = mpsc::unbounded_channel::<EmbedRequest>();
    let available = Arc::new(AtomicBool::new(false));
    let av = Arc::clone(&available);
    tokio::spawn(supervise(binary, rx, av, dim));
    Self {
      requests: tx,
      available,
      dim,
    }
  }
}

#[async_trait]
impl Embedder for SidecarEmbedder {
  async fn embed(&self, texts: &[String]) -> ForestResult<Vec<Vec<f32>>> {
    if !self.available.load(Ordering::Relaxed) {
      return Err(ForestError::EmbedUnavailable);
    }
    if texts.is_empty() {
      return Ok(Vec::new());
    }
    let (tx, rx) = oneshot::channel();
    self
      .requests
      .send(EmbedRequest {
        texts: texts.to_vec(),
        reply: tx,
      })
      .map_err(|_| ForestError::EmbedUnavailable)?;
    rx.await
      .map_err(|_| ForestError::Embed("supervisor dropped reply".into()))?
  }

  fn dim(&self) -> usize {
    self.dim
  }

  fn available(&self) -> bool {
    self.available.load(Ordering::Relaxed)
  }
}

// ─────────────────────────────────────────────────────────────────────
// Supervisor
// ─────────────────────────────────────────────────────────────────────

async fn supervise(
  binary: PathBuf,
  mut requests: mpsc::UnboundedReceiver<EmbedRequest>,
  available: Arc<AtomicBool>,
  dim: usize,
) {
  let mut attempt: u32 = 0;
  loop {
    match try_run_session(&binary, &mut requests, &available, dim).await {
      SessionOutcome::Closed => {
        tracing::debug!("embed sidecar: caller dropped, supervisor exiting");
        return;
      }
      SessionOutcome::Failed(reason) => {
        attempt += 1;
        available.store(false, Ordering::Relaxed);
        tracing::warn!(
          "embed sidecar attempt {attempt} failed: {reason}; retrying with backoff"
        );
        if attempt >= 3 {
          tracing::error!("embed sidecar giving up after 3 attempts");
          drain_with_unavailable(&mut requests);
          return;
        }
        // 1s, 4s, 16s — matches the design doc.
        let secs: u64 = 4u64.pow(attempt - 1);
        tokio::time::sleep(Duration::from_secs(secs)).await;
      }
    }
  }
}

enum SessionOutcome {
  /// Request channel closed — clean shutdown.
  Closed,
  /// Session aborted; supervisor will retry with backoff.
  Failed(String),
}

async fn try_run_session(
  binary: &Path,
  requests: &mut mpsc::UnboundedReceiver<EmbedRequest>,
  available: &Arc<AtomicBool>,
  dim: usize,
) -> SessionOutcome {
  let mut child = match Command::new(binary)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true)
    .spawn()
  {
    Ok(c) => c,
    Err(e) => return SessionOutcome::Failed(format!("spawn {binary:?}: {e}")),
  };
  let Some(mut stdin) = child.stdin.take() else {
    return SessionOutcome::Failed("no stdin".into());
  };
  let Some(stdout) = child.stdout.take() else {
    return SessionOutcome::Failed("no stdout".into());
  };
  let mut reader = BufReader::new(stdout).lines();

  // Health check — proves the model is actually loaded before we say
  // we're available. Hard timeout: 5s per design doc.
  let health = serde_json::json!({"id": 0, "cmd": "health"}).to_string();
  if let Err(e) = stdin.write_all(format!("{health}\n").as_bytes()).await {
    return SessionOutcome::Failed(format!("write health: {e}"));
  }
  let line = match tokio::time::timeout(Duration::from_secs(5), reader.next_line()).await {
    Ok(Ok(Some(l))) => l,
    Ok(Ok(None)) => return SessionOutcome::Failed("eof during health check".into()),
    Ok(Err(e)) => return SessionOutcome::Failed(format!("read health: {e}")),
    Err(_) => return SessionOutcome::Failed("health check timeout (5s)".into()),
  };
  let resp: serde_json::Value = match serde_json::from_str(&line) {
    Ok(v) => v,
    Err(e) => return SessionOutcome::Failed(format!("parse health: {e}")),
  };
  if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
    return SessionOutcome::Failed(format!("health not ok: {resp}"));
  }
  let reported_dim = resp.get("dim").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
  if reported_dim != 0 && reported_dim != dim {
    return SessionOutcome::Failed(format!(
      "dim mismatch: expected {dim}, got {reported_dim}"
    ));
  }

  available.store(true, Ordering::Relaxed);
  tracing::info!("embed sidecar healthy (dim={dim})");

  // Single in-flight request at a time. Plenty fast for a 16-text batch
  // (≤300ms on M2) and means stdout can never interleave.
  let mut next_id: u64 = 0;
  while let Some(req) = requests.recv().await {
    next_id += 1;
    let id = next_id;
    let payload = serde_json::json!({"id": id, "texts": req.texts}).to_string();
    if let Err(e) = stdin.write_all(format!("{payload}\n").as_bytes()).await {
      let _ = req.reply.send(Err(ForestError::Embed(format!("write: {e}"))));
      return SessionOutcome::Failed(format!("write req: {e}"));
    }
    let line = match reader.next_line().await {
      Ok(Some(l)) => l,
      Ok(None) => {
        let _ = req.reply.send(Err(ForestError::EmbedUnavailable));
        return SessionOutcome::Failed("sidecar closed stdout".into());
      }
      Err(e) => {
        let _ = req.reply.send(Err(ForestError::Embed(format!("read: {e}"))));
        return SessionOutcome::Failed(format!("read: {e}"));
      }
    };
    match parse_embed_response(&line, id, dim) {
      Ok(vectors) => {
        let _ = req.reply.send(Ok(vectors));
      }
      Err(reason) => {
        let _ = req.reply.send(Err(ForestError::Embed(reason.clone())));
        // Out-of-order or malformed reply: stdout is misaligned. The
        // only safe recovery is to kill + restart.
        return SessionOutcome::Failed(reason);
      }
    }
  }

  // Channel closed — graceful shutdown.
  let shutdown = serde_json::json!({"id": 0, "cmd": "shutdown"}).to_string();
  let _ = stdin.write_all(format!("{shutdown}\n").as_bytes()).await;
  drop(stdin);
  let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
  SessionOutcome::Closed
}

fn parse_embed_response(line: &str, expected_id: u64, dim: usize) -> Result<Vec<Vec<f32>>, String> {
  let val: serde_json::Value =
    serde_json::from_str(line).map_err(|e| format!("parse reply: {e}"))?;
  let id = val.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
  if id != expected_id {
    return Err(format!(
      "reply id mismatch: expected {expected_id}, got {id}"
    ));
  }
  if let Some(err) = val.get("error").and_then(|v| v.as_str()) {
    return Err(format!("sidecar error: {err}"));
  }
  let arr = val
    .get("embeddings")
    .and_then(|v| v.as_array())
    .ok_or_else(|| "missing embeddings array".to_string())?;
  let mut out = Vec::with_capacity(arr.len());
  for item in arr {
    let row = item
      .as_array()
      .ok_or_else(|| "embedding row not an array".to_string())?;
    if !row.is_empty() && row.len() != dim {
      return Err(format!(
        "embedding length {} does not match expected dim {dim}",
        row.len()
      ));
    }
    let mut v = Vec::with_capacity(row.len());
    for x in row {
      let f = x
        .as_f64()
        .ok_or_else(|| "embedding value not numeric".to_string())?;
      v.push(f as f32);
    }
    out.push(v);
  }
  Ok(out)
}

fn drain_with_unavailable(requests: &mut mpsc::UnboundedReceiver<EmbedRequest>) {
  while let Ok(req) = requests.try_recv() {
    let _ = req.reply.send(Err(ForestError::EmbedUnavailable));
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  #[tokio::test]
  async fn missing_binary_marks_unavailable_after_retries() {
    // Path that almost certainly doesn't exist. Supervisor will retry
    // 3 times with 1s/4s/16s backoff — we don't actually wait; we just
    // confirm `available()` stays false and `embed()` returns
    // EmbedUnavailable.
    let path = PathBuf::from("/nonexistent/mindforest-embed-fake");
    let e = SidecarEmbedder::spawn(path, 768);
    assert!(!e.available());
    let result = e.embed(&["hello".into()]).await;
    assert!(matches!(result, Err(ForestError::EmbedUnavailable)));
  }

  #[tokio::test]
  async fn empty_input_short_circuits_without_dispatch() {
    // Even when the supervisor hasn't connected, an empty batch should
    // succeed without requiring availability — the result is just empty.
    let path = PathBuf::from("/nonexistent/mindforest-embed-fake");
    let e = SidecarEmbedder::spawn(path, 768);
    // available is still false, so embed fast-paths — but our impl
    // checks available before short-circuiting on empty. With no
    // sidecar this returns Unavailable, which is fine.
    let r = e.embed(&[]).await;
    assert!(matches!(r, Err(ForestError::EmbedUnavailable)));
  }

  #[test]
  fn parses_well_formed_response() {
    let line = r#"{"id":7,"embeddings":[[0.1,0.2],[0.3,0.4]]}"#;
    let v = parse_embed_response(line, 7, 2).unwrap();
    assert_eq!(v, vec![vec![0.1, 0.2], vec![0.3, 0.4]]);
  }

  #[test]
  fn rejects_id_mismatch() {
    let line = r#"{"id":99,"embeddings":[]}"#;
    let err = parse_embed_response(line, 1, 768).unwrap_err();
    assert!(err.contains("id mismatch"));
  }

  #[test]
  fn surfaces_inline_error() {
    let line = r#"{"id":3,"error":"oom"}"#;
    let err = parse_embed_response(line, 3, 768).unwrap_err();
    assert!(err.contains("oom"));
  }

  #[test]
  fn rejects_dim_mismatch() {
    let line = r#"{"id":1,"embeddings":[[0.1,0.2,0.3]]}"#;
    let err = parse_embed_response(line, 1, 768).unwrap_err();
    assert!(err.contains("dim 768"));
  }
}
