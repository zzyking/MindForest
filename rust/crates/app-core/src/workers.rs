//! Background workers — the two long-lived tasks that keep the derived
//! index in step with the world:
//!
//! - **Watcher loop**: consumes `WatchEvent`s from storage-fs and applies
//!   them to the index, keeping search results fresh against external
//!   edits (the user opens a `.md` in VS Code, hits save).
//! - **Embed worker**: drains pending `embed_jobs`, runs them through the
//!   `Embedder` in batches, and writes vectors back into `nodes_vec`.
//!   Wakes on a `Notify` after every node mutation; idle ticks at 60s.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use domain::{ForestError, ForestResult};
use index_sqlite::content_hash_for;
use storage_fs::{node_id_from_path, WatchEvent};

use crate::ForestService;

impl ForestService {
  // ─── Watcher integration ──────────────────────────────────────────

  /// Spawn a background task that consumes filesystem events and keeps
  /// the index in sync. Returns a `JoinHandle`; the task ends when the
  /// stream closes (e.g., the `WatcherHandle` is dropped).
  pub fn spawn_watcher(
    self: Arc<Self>,
    mut events: mpsc::UnboundedReceiver<WatchEvent>,
  ) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
      while let Some(ev) = events.recv().await {
        if let Err(e) = self.handle_watch_event(ev).await {
          tracing::warn!("watcher event handler error: {e}");
        }
      }
    })
  }

  async fn handle_watch_event(&self, ev: WatchEvent) -> ForestResult<()> {
    match ev {
      WatchEvent::Changed(path) => {
        let Some(id) = node_id_from_path(&path) else {
          return Ok(());
        };
        match self.repo.read_node(&id).await {
          Ok(node) => {
            self.index.upsert(&node).await?;
            self.embed_notify.notify_one();
          }
          Err(ForestError::NodeNotFound(_)) => {
            self.index.delete(&id).await?;
          }
          Err(e) => return Err(e),
        }
      }
      WatchEvent::Removed(path) => {
        if let Some(id) = node_id_from_path(&path) {
          self.index.delete(&id).await?;
        }
      }
    }
    Ok(())
  }

  // ─── Embed worker ─────────────────────────────────────────────────

  /// Spawn the embed worker. Idempotent in spirit but not enforced —
  /// callers spawn exactly once at boot. The worker runs forever; it
  /// only stops if the runtime is shut down.
  pub fn spawn_embed_worker(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
      // First pass on start so any leftover pending rows from a prior
      // session are drained without waiting for a notify.
      if let Err(e) = self.run_embed_batch().await {
        tracing::debug!("embed worker initial batch: {e}");
      }
      loop {
        tokio::select! {
          _ = self.embed_notify.notified() => {}
          _ = tokio::time::sleep(Duration::from_secs(60)) => {}
        }
        if !self.embedder.available() {
          continue;
        }
        if let Err(e) = self.run_embed_batch().await {
          tracing::warn!("embed worker batch: {e}");
        }
      }
    })
  }

  async fn run_embed_batch(&self) -> ForestResult<()> {
    if !self.embedder.available() {
      return Ok(());
    }
    // Fetch a batch. The plan calls for 16 — small enough to keep
    // sidecar batches snappy, large enough to amortize JSON overhead.
    let jobs = self.index.pending_embed_jobs(16).await?;
    if jobs.is_empty() {
      return Ok(());
    }

    // Read each node, dropping any whose content_hash has drifted (a
    // newer upsert is already pending and will land us back here with
    // the right hash) or that have been deleted in flight.
    let mut texts = Vec::with_capacity(jobs.len());
    let mut ids = Vec::with_capacity(jobs.len());
    let mut hashes = Vec::with_capacity(jobs.len());
    for job in jobs {
      match self.repo.read_node(&job.id).await {
        Ok(n) => {
          let current = content_hash_for(&n.title, &n.content);
          if current != job.content_hash {
            tracing::debug!("embed worker: skipping {}, hash drift", n.id);
            continue;
          }
          // Embed both title and body — the title carries a lot of
          // semantic weight per token, especially for short notes.
          texts.push(format!("{}\n\n{}", n.title, n.content));
          ids.push(n.id);
          hashes.push(current);
        }
        Err(ForestError::NodeNotFound(_)) => {
          tracing::debug!("embed worker: node {} gone, skipping", job.id);
        }
        Err(e) => {
          tracing::warn!("embed worker: read_node({}) error: {e}", job.id);
        }
      }
    }
    if texts.is_empty() {
      return Ok(());
    }

    let vectors = self.embedder.embed(&texts).await?;
    if vectors.len() != texts.len() {
      return Err(ForestError::Embed(format!(
        "embedder returned {} vectors for {} texts",
        vectors.len(),
        texts.len()
      )));
    }

    for ((id, hash), vec) in ids.iter().zip(hashes.iter()).zip(vectors.iter()) {
      if let Err(e) = self.index.upsert_embedding(id, hash, vec).await {
        tracing::warn!("embed worker: upsert_embedding({}) error: {e}", id);
        let _ = self.index.mark_embed_error(id, &e.to_string()).await;
      }
    }
    Ok(())
  }
}
