//! `app-core` — composition layer.
//!
//! Wires the markdown-backed `ForestRepository` (storage-fs), the
//! SQLite-backed `Indexer` (index-sqlite), and the `Embedder` (`embed`)
//! into a single `ForestService` that the HTTP layer (apps/api) talks
//! to. Owns four concerns that span more than one backend:
//!
//! - **Transactional write boundary**: every node mutation does the file
//!   write first (authoritative), then the index update. Index failures
//!   are surfaced to the caller; the file is still committed and the
//!   index will catch up via `rebuild_index` or watcher events.
//! - **Watcher loop**: consumes `WatchEvent`s from storage-fs and applies
//!   them to the index, keeping search results fresh against external
//!   edits (the user opens a `.md` in VS Code, hits save).
//! - **Embed worker**: drains pending `embed_jobs`, runs them through the
//!   `Embedder` in batches, and writes vectors back into `nodes_vec`.
//!   Wakes on a `Notify` after every node mutation; idle ticks at 60s.
//! - **Search composition**: hybrid (FTS + vec) via reciprocal rank
//!   fusion. When the embedder is unavailable we silently degrade to
//!   FTS-only — the rest of the system doesn't have to care.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use futures::Stream;
use tokio::sync::{mpsc, Notify, RwLock};

use domain::{
  Embedder, ForestError, ForestRepository, ForestResult, IndexStatus, Indexer, NewNode, NewTopic,
  Node, NodeId, NodePatch, SearchHit, Topic, TopicId, TopicSummary,
};

pub use agent::{
  AgentAnthropicConfig, AgentConfig, AgentEvent, AgentOpenAIConfig, AgentProposer, AgentProvider,
  AgentRequest, AgentRole, AgentStream, AgentTurn,
};
pub use embed::download::{DownloadEvent, FileStatus, ModelDownloader, ModelStatus};
pub use embed::{EmbedMode, StubEmbedder, UnavailableEmbedder};
pub use index_sqlite::{content_hash_for, SqliteIndex, EMBED_DIM};
pub use storage_fs::{node_id_from_path, FsRepository, WatchEvent, WatcherHandle};

/// The model the sidecar's MLX path expects. Hardcoded to keep the API
/// surface narrow — the frontend never picks a model. If we ever need
/// alternates we'll add a registry here.
pub const EMBEDDING_MODEL_REPO: &str = "mlx-community/embeddinggemma-300m-4bit";

/// Files we treat as "required" for the local model directory to be
/// considered ready. EmbeddingGemma 300M 4-bit is small enough to fit
/// in a single safetensors shard, so no `model-00001-of-N.safetensors`
/// pattern needed. If the upstream switches to sharding, the download
/// path still pulls everything; this list just gates the `present` flag.
pub const EMBEDDING_MODEL_FILES: &[&str] = &[
  "config.json",
  "model.safetensors",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
];

/// Wired-up service plus the watcher handle required to keep the index
/// reactive to external edits. Callers must spawn the watcher loop
/// (`service.clone().spawn_watcher(watcher.events)`) and the embed
/// worker (`service.clone().spawn_embed_worker()`), and hold the
/// `watcher` binding for the lifetime of the process — its private
/// debouncer field stops watching when dropped.
pub struct Bootstrap {
  pub service: Arc<ForestService>,
  pub watcher: WatcherHandle,
}

/// HTTP-shaped model status reply — wraps `ModelStatus` with the local
/// embed-mode label so the frontend can decide whether to surface the
/// download UI at all.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ModelStatusResponse {
  pub repo_id: String,
  pub dir: PathBuf,
  pub present: bool,
  pub files: Vec<FileStatus>,
  /// `"off"` / `"stub"` / `"sidecar"` — the user-visible name of the
  /// embedder backend currently in play.
  pub embed_mode: String,
}

fn embed_mode_label(mode: &EmbedMode) -> String {
  match mode {
    EmbedMode::Off => "off".into(),
    EmbedMode::Stub => "stub".into(),
    EmbedMode::Sidecar { .. } => "sidecar".into(),
  }
}

/// Read `agent.json` from disk, falling back to the default config when
/// the file is missing or malformed. Reasons to fail soft: a clean
/// install hasn't written one yet, and we don't want a broken settings
/// file to brick the entire app.
async fn load_agent_config(path: &std::path::Path) -> AgentConfig {
  let bytes = match tokio::fs::read(path).await {
    Ok(b) => b,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return AgentConfig::default(),
    Err(e) => {
      tracing::warn!("agent config read failed at {path:?}: {e}; using defaults");
      return AgentConfig::default();
    }
  };
  match serde_json::from_slice::<AgentConfig>(&bytes) {
    Ok(cfg) => cfg,
    Err(e) => {
      tracing::warn!("agent config parse failed at {path:?}: {e}; using defaults");
      AgentConfig::default()
    }
  }
}

/// Open the vault, prepare the derived SQLite index, build an embedder
/// from `mode`, and compose them into a `ForestService`. Rebuilds the
/// index from filesystem state only when `index.db` doesn't yet exist;
/// once present, trust the index and rely on watcher events for updates.
/// A user-triggered `POST /index/rebuild` covers the rare case where the
/// index drifts.
///
/// `vault` holds the user's markdown source-of-truth; `data_dir` is the
/// app-owned directory for derived state — sqlite index + downloaded
/// MLX model weights. They are intentionally separable so a user who
/// moves the vault (e.g. into iCloud Drive) doesn't drag regenerable
/// artifacts along. Both paths are absolute and the caller decides
/// where they live; bootstrap doesn't append further path segments.
pub async fn bootstrap(
  vault: PathBuf,
  data_dir: PathBuf,
  embed_mode: EmbedMode,
) -> ForestResult<Bootstrap> {
  let repo = Arc::new(FsRepository::open(&vault).await?);

  tokio::fs::create_dir_all(&data_dir)
    .await
    .map_err(|e| ForestError::Storage(format!("create {}: {e}", data_dir.display())))?;
  let index_path = data_dir.join("index.db");
  let needs_rebuild = !index_path.exists();
  let index = Arc::new(SqliteIndex::open(&index_path).await?);
  if needs_rebuild {
    index.rebuild_from(repo.as_ref()).await?;
  }

  let downloader = ModelDownloader::new(data_dir.join("models"));
  let embedder = embed::build_embedder(
    embed_mode.clone(),
    Some(downloader.target_dir(EMBEDDING_MODEL_REPO)),
  );
  // Persisted agent settings live next to the index. If the file is
  // missing or unreadable we fall back to env-driven defaults so a
  // first-time launch still works without writing to disk.
  let agent_config_path = data_dir.join("agent.json");
  let agent_config = load_agent_config(&agent_config_path).await;
  let proposer = agent::build_proposer_from_config(&agent_config);
  let service = Arc::new(ForestService::new(
    repo.clone(),
    index,
    embedder,
    embed_mode,
    downloader,
    proposer,
    agent_config,
    agent_config_path,
  ));
  let watcher = repo.watch()?;
  Ok(Bootstrap { service, watcher })
}

#[derive(Clone)]
pub struct ForestService {
  repo: Arc<dyn ForestRepository>,
  index: Arc<dyn Indexer>,
  embedder: Arc<dyn Embedder>,
  /// Wakes the embed worker after a write — the worker prefers to react
  /// to a notify rather than poll, so newly-enqueued jobs land in the
  /// vector index without a 60s lag.
  embed_notify: Arc<Notify>,
  /// Whether the embedder is `Off` / `Stub` / `Sidecar`. The frontend
  /// reads this through `model_status()` to decide whether to surface
  /// the download UX (no point asking a stub-only user to fetch a model
  /// they won't use). Stored as a string for `Clone`-friendliness.
  embed_mode_label: String,
  downloader: ModelDownloader,
  /// LLM proposer behind a swap-friendly RwLock so the settings UI can
  /// switch providers at runtime. The inner `Arc` keeps `propose()`
  /// cheap (`read().await.clone()` clones the Arc, not the proposer).
  proposer: Arc<RwLock<Arc<dyn AgentProposer>>>,
  /// Mirror of the persisted `AgentConfig`. Held alongside the proposer
  /// so the HTTP `GET /v1/agent/config` route can return the current
  /// settings without re-reading the file.
  agent_config: Arc<RwLock<AgentConfig>>,
  /// Where the persisted agent config lives. `None` for in-memory test
  /// fixtures that don't want disk writes.
  agent_config_path: Option<PathBuf>,
}

impl ForestService {
  pub fn new(
    repo: Arc<dyn ForestRepository>,
    index: Arc<dyn Indexer>,
    embedder: Arc<dyn Embedder>,
    embed_mode: EmbedMode,
    downloader: ModelDownloader,
    proposer: Arc<dyn AgentProposer>,
    agent_config: AgentConfig,
    agent_config_path: impl Into<Option<PathBuf>>,
  ) -> Self {
    Self {
      repo,
      index,
      embedder,
      embed_notify: Arc::new(Notify::new()),
      embed_mode_label: embed_mode_label(&embed_mode),
      downloader,
      proposer: Arc::new(RwLock::new(proposer)),
      agent_config: Arc::new(RwLock::new(agent_config)),
      agent_config_path: agent_config_path.into(),
    }
  }

  // ─── Topic ────────────────────────────────────────────────────────

  pub async fn list_topics(&self) -> ForestResult<Vec<TopicSummary>> {
    self.repo.list_topics().await
  }

  pub async fn get_topic(&self, id: &TopicId) -> ForestResult<Topic> {
    self.repo.get_topic(id).await
  }

  pub async fn create_topic(&self, new: NewTopic) -> ForestResult<Topic> {
    let topic = self.repo.create_topic(new).await?;
    let root = self.repo.read_node(&topic.root_node_id).await?;
    self.index.upsert(&root).await?;
    self.embed_notify.notify_one();
    Ok(topic)
  }

  pub async fn delete_topic(&self, id: &TopicId) -> ForestResult<()> {
    let nodes = self.repo.list_nodes_in_topic(id).await?;
    self.repo.delete_topic(id).await?;
    for n in nodes {
      if let Err(e) = self.index.delete(&n.id).await {
        tracing::warn!("delete_topic: failed to unindex {}: {e}", n.id);
      }
    }
    Ok(())
  }

  // ─── Node ─────────────────────────────────────────────────────────

  pub async fn get_node(&self, id: &NodeId) -> ForestResult<Node> {
    self.repo.read_node(id).await
  }

  pub async fn list_nodes_in_topic(&self, topic: &TopicId) -> ForestResult<Vec<Node>> {
    self.repo.list_nodes_in_topic(topic).await
  }

  pub async fn create_node(&self, new: NewNode) -> ForestResult<Node> {
    let now = Utc::now();
    let node = Node {
      id: NodeId::new(),
      topic: new.topic,
      parent: new.parent,
      node_type: new.node_type,
      title: new.title,
      content: new.content,
      links: vec![],
      created_at: now,
      updated_at: now,
      color: None,
    };
    self.repo.write_node(&node).await?;
    self.index.upsert(&node).await?;
    self.embed_notify.notify_one();
    Ok(node)
  }

  pub async fn update_node(&self, id: &NodeId, patch: NodePatch) -> ForestResult<Node> {
    let mut node = self.repo.read_node(id).await?;
    if let Some(t) = patch.title {
      node.title = t;
    }
    if let Some(c) = patch.content {
      node.content = c;
    }
    if let Some(l) = patch.links {
      node.links = l;
    }
    if let Some(ty) = patch.node_type {
      node.node_type = ty;
    }
    if let Some(new_parent) = patch.parent {
      self.validate_reparent(&node, &new_parent).await?;
      node.parent = Some(new_parent);
    }
    node.updated_at = Utc::now();
    self.repo.write_node(&node).await?;
    self.index.upsert(&node).await?;
    self.embed_notify.notify_one();
    Ok(node)
  }

  /// Reparent guard. Reject:
  ///   - reparenting the topic root (its parent must stay None)
  ///   - moving a node onto itself
  ///   - moving a node under one of its own descendants (cycle)
  ///   - moving a node into a different topic (cross-topic moves are
  ///     not yet supported — the file would need to migrate between
  ///     topic dirs and we don't surface that affordance in the UI)
  async fn validate_reparent(&self, node: &Node, new_parent: &NodeId) -> ForestResult<()> {
    let topic = self.repo.get_topic(&node.topic).await?;
    if node.id == topic.root_node_id {
      return Err(ForestError::InvalidInput(
        "cannot reparent the topic root".into(),
      ));
    }
    if &node.id == new_parent {
      return Err(ForestError::InvalidInput(
        "cannot reparent a node onto itself".into(),
      ));
    }
    let parent_node = self.repo.read_node(new_parent).await?;
    if parent_node.topic != node.topic {
      return Err(ForestError::InvalidInput(
        "cross-topic reparent is not supported".into(),
      ));
    }
    // Walk the new parent's ancestor chain. If we hit `node.id`, accepting
    // this move would create a cycle.
    let mut cursor = parent_node.parent.clone();
    while let Some(p) = cursor {
      if p == node.id {
        return Err(ForestError::InvalidInput(
          "cannot reparent a node under one of its own descendants".into(),
        ));
      }
      cursor = self.repo.read_node(&p).await?.parent;
    }
    Ok(())
  }

  pub async fn delete_node(&self, id: &NodeId) -> ForestResult<()> {
    self.repo.delete_node(id).await?;
    self.index.delete(id).await?;
    Ok(())
  }

  // ─── Search ───────────────────────────────────────────────────────

  /// Hybrid search. Always runs FTS; runs vec in parallel iff the
  /// embedder is available. Results are fused via Reciprocal Rank Fusion
  /// (k_rrf=60) — robust without per-feature score normalization, and
  /// well-studied as a hybrid baseline.
  pub async fn search(
    &self,
    query: &str,
    topic: Option<&TopicId>,
    k: usize,
  ) -> ForestResult<Vec<SearchHit>> {
    if !self.embedder.available() {
      return self.index.search_fts(query, topic, k).await;
    }
    // Over-fetch on each side so the fusion has room to elevate
    // candidates that show up near-but-not-top in either ranking.
    let candidate_k = (k * 2).max(10);
    let q_str = query.to_string();
    let topic_owned = topic.cloned();

    // Borrow-friendly closures so both branches can reference self.
    let fts_fut = async {
      self
        .index
        .search_fts(&q_str, topic_owned.as_ref(), candidate_k)
        .await
    };
    let vec_fut = async {
      // Embed the query text. If embedding fails (e.g. sidecar dies
      // mid-request), we fall through to FTS-only by yielding an empty
      // Vec — see how `match` handles it below.
      let mut embed_out = self.embedder.embed(std::slice::from_ref(&q_str)).await?;
      let q_vec = embed_out
        .pop()
        .ok_or_else(|| ForestError::Embed("empty embed result for query".into()))?;
      self
        .index
        .search_vec(&q_vec, topic_owned.as_ref(), candidate_k)
        .await
    };

    let (fts_res, vec_res) = tokio::join!(fts_fut, vec_fut);
    let fts_hits = fts_res?;
    let vec_hits = vec_res.unwrap_or_else(|e| {
      tracing::debug!("search: vec arm failed, FTS-only: {e}");
      Vec::new()
    });

    Ok(fuse_rrf(fts_hits, vec_hits, k))
  }

  pub async fn index_status(&self) -> ForestResult<IndexStatus> {
    let mut status = self.index.status().await?;
    status.embed_available = self.embedder.available();
    Ok(status)
  }

  // ─── Model download ──────────────────────────────────────────────

  /// Local snapshot of the EmbeddingGemma weights — does the model
  /// directory contain every file we expect to hand to the sidecar?
  /// Augmented with the embedder mode so the frontend can decide
  /// whether the download UI is even relevant.
  pub async fn model_status(&self) -> ForestResult<ModelStatusResponse> {
    let local = self
      .downloader
      .local_status(EMBEDDING_MODEL_REPO, EMBEDDING_MODEL_FILES)
      .await?;
    Ok(ModelStatusResponse {
      repo_id: local.repo_id,
      dir: local.dir,
      present: local.present,
      files: local.files,
      embed_mode: self.embed_mode_label.clone(),
    })
  }

  /// Stream the EmbeddingGemma download. Each event is emitted exactly
  /// once and the stream ends after `Done` (or `Error`). Caller is the
  /// HTTP handler that turns events into SSE frames.
  pub fn download_model(&self) -> impl Stream<Item = DownloadEvent> + Send + 'static {
    self.downloader.download(EMBEDDING_MODEL_REPO.to_string())
  }

  // ─── Agent ───────────────────────────────────────────────────────

  /// Build the agent context (full topic + node list) and dispatch.
  /// The returned stream is alive for the duration of one HTTP SSE
  /// response; the route handler maps each `AgentEvent` to a frame.
  pub async fn propose(
    &self,
    topic_id: &TopicId,
    focused_node_id: Option<NodeId>,
    prompt: String,
    history: Vec<agent::AgentTurn>,
  ) -> ForestResult<AgentStream> {
    let topic = self.repo.get_topic(topic_id).await?;
    let nodes = self.repo.list_nodes_in_topic(topic_id).await?;
    let req = AgentRequest {
      topic,
      nodes,
      focused_node_id,
      prompt,
      history,
    };
    let proposer = self.proposer.read().await.clone();
    proposer.propose(req).await
  }

  /// Backend label, e.g. `"stub"`, `"gpt-4o-mini (api.openai.com)"`,
  /// `"claude-sonnet-4-6 (anthropic)"`. Surfaced via the agent status
  /// endpoint so the UI can render a "powered by …" hint.
  pub async fn agent_backend(&self) -> String {
    self.proposer.read().await.backend().to_string()
  }

  /// Snapshot of the persisted agent configuration, with API keys
  /// included verbatim. The HTTP route exposes this on loopback only;
  /// callers outside the service should not relay it elsewhere.
  pub async fn agent_config(&self) -> AgentConfig {
    self.agent_config.read().await.clone()
  }

  /// Persist a new `AgentConfig` and rebuild the proposer. Returns the
  /// new backend label so the caller (HTTP route) can echo it back to
  /// the UI without a second round-trip.
  pub async fn set_agent_config(&self, config: AgentConfig) -> ForestResult<String> {
    if let Some(path) = self.agent_config_path.as_ref() {
      let bytes = serde_json::to_vec_pretty(&config)
        .map_err(|e| ForestError::Storage(format!("serialize agent config: {e}")))?;
      // Atomic-ish: write to a sibling path then rename. Stops a crash
      // mid-write from leaving an empty / truncated file.
      if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
          .await
          .map_err(|e| ForestError::Storage(format!("create {parent:?}: {e}")))?;
      }
      let tmp = path.with_extension("json.tmp");
      tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| ForestError::Storage(format!("write {tmp:?}: {e}")))?;
      // 0600 — best-effort on unix; ignored on platforms without it.
      #[cfg(unix)]
      {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).await;
      }
      tokio::fs::rename(&tmp, path)
        .await
        .map_err(|e| ForestError::Storage(format!("rename {tmp:?}→{path:?}: {e}")))?;
    }
    let new_proposer = agent::build_proposer_from_config(&config);
    let backend = new_proposer.backend().to_string();
    *self.proposer.write().await = new_proposer;
    *self.agent_config.write().await = config;
    Ok(backend)
  }

  // ─── Index ────────────────────────────────────────────────────────

  pub async fn rebuild_index(&self) -> ForestResult<()> {
    self.index.rebuild_from(self.repo.as_ref()).await?;
    // The rebuild repopulates `embed_jobs` with one pending row per
    // node, so wake the worker to start chewing through them.
    self.embed_notify.notify_one();
    Ok(())
  }

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

// ─────────────────────────────────────────────────────────────────────
// Reciprocal Rank Fusion
// ─────────────────────────────────────────────────────────────────────

/// Standard RRF: each ranking contributes `1 / (k_rrf + rank)` per id;
/// final score is the sum across rankings. The constant 60 is the value
/// recommended by Cormack et al. and commonly used elsewhere; it's
/// robust enough that we don't expose it as a knob.
fn fuse_rrf(
  fts: Vec<SearchHit>,
  vec: Vec<SearchHit>,
  k: usize,
) -> Vec<SearchHit> {
  const K_RRF: f32 = 60.0;
  let mut scores: HashMap<NodeId, f32> = HashMap::new();
  let mut details: HashMap<NodeId, SearchHit> = HashMap::new();

  let push = |hits: Vec<SearchHit>,
              scores: &mut HashMap<NodeId, f32>,
              details: &mut HashMap<NodeId, SearchHit>| {
    for (rank, hit) in hits.into_iter().enumerate() {
      *scores.entry(hit.id).or_insert(0.0) += 1.0 / (K_RRF + rank as f32 + 1.0);
      // Prefer the FTS detail (it has the highlighted snippet); the vec
      // arm fills in `snippet=""`, so an existing entry never gets
      // downgraded by being overwritten with vec data.
      details.entry(hit.id).or_insert(hit);
    }
  };
  push(fts, &mut scores, &mut details);
  push(vec, &mut scores, &mut details);

  let mut entries: Vec<(NodeId, f32)> = scores.into_iter().collect();
  entries.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
  entries
    .into_iter()
    .take(k)
    .filter_map(|(id, score)| {
      details.remove(&id).map(|mut h| {
        h.score = score;
        h
      })
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use agent::StubProposer;
  use chrono::Utc;
  use domain::NodeType;
  use embed::StubEmbedder;
  use index_sqlite::SqliteIndex;
  use std::time::Duration;
  use tempfile::TempDir;
  use tokio::time::timeout;

  async fn fixture() -> (TempDir, Arc<ForestService>) {
    let tmp = TempDir::new().unwrap();
    let repo = FsRepository::open(tmp.path()).await.unwrap();
    let index = SqliteIndex::open_in_memory().await.unwrap();
    let downloader = ModelDownloader::new(tmp.path().join("models"));
    let svc = Arc::new(ForestService::new(
      Arc::new(repo),
      Arc::new(index),
      Arc::new(StubEmbedder::new(EMBED_DIM)),
      EmbedMode::Stub,
      downloader,
      Arc::new(StubProposer::new()),
      AgentConfig::default(),
      None,
    ));
    (tmp, svc)
  }

  async fn fixture_no_embed() -> (TempDir, Arc<ForestService>) {
    let tmp = TempDir::new().unwrap();
    let repo = FsRepository::open(tmp.path()).await.unwrap();
    let index = SqliteIndex::open_in_memory().await.unwrap();
    let downloader = ModelDownloader::new(tmp.path().join("models"));
    let svc = Arc::new(ForestService::new(
      Arc::new(repo),
      Arc::new(index),
      Arc::new(UnavailableEmbedder::new(EMBED_DIM)),
      EmbedMode::Off,
      downloader,
      Arc::new(StubProposer::new()),
      AgentConfig::default(),
      None,
    ));
    (tmp, svc)
  }

  #[tokio::test]
  async fn create_topic_indexes_root_node() {
    let (_tmp, svc) = fixture().await;
    let topic = svc
      .create_topic(NewTopic {
        title: "Knowledge".into(),
        slug: None,
      })
      .await
      .unwrap();
    let hits = svc.search("Knowledge", None, 10).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, topic.root_node_id);
  }

  #[tokio::test]
  async fn create_node_writes_file_and_indexes() {
    let (_tmp, svc) = fixture().await;
    let topic = svc
      .create_topic(NewTopic {
        title: "Test".into(),
        slug: None,
      })
      .await
      .unwrap();
    let node = svc
      .create_node(NewNode {
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id),
        title: "Backpropagation".into(),
        content: "Gradients flow backwards.".into(),
        node_type: NodeType::Concept,
      })
      .await
      .unwrap();

    let read = svc.get_node(&node.id).await.unwrap();
    assert_eq!(read.title, "Backpropagation");

    let hits = svc.search("gradients", None, 10).await.unwrap();
    assert!(hits.iter().any(|h| h.id == node.id));
  }

  #[tokio::test]
  async fn update_node_refreshes_index() {
    let (_tmp, svc) = fixture().await;
    let topic = svc
      .create_topic(NewTopic {
        title: "Test".into(),
        slug: None,
      })
      .await
      .unwrap();
    let node = svc
      .create_node(NewNode {
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id),
        title: "Old".into(),
        content: "version one".into(),
        node_type: NodeType::Concept,
      })
      .await
      .unwrap();

    svc
      .update_node(
        &node.id,
        NodePatch {
          title: Some("New".into()),
          content: Some("version two".into()),
          ..Default::default()
        },
      )
      .await
      .unwrap();

    let stale = svc.search("version one", None, 10).await.unwrap();
    assert!(!stale.iter().any(|h| h.id == node.id));
    let fresh = svc.search("version two", None, 10).await.unwrap();
    assert!(fresh.iter().any(|h| h.title == "New"));
  }

  #[tokio::test]
  async fn reparent_moves_node_under_new_parent() {
    let (_tmp, svc) = fixture().await;
    let topic = svc
      .create_topic(NewTopic {
        title: "T".into(),
        slug: None,
      })
      .await
      .unwrap();
    let a = svc
      .create_node(NewNode {
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id.clone()),
        title: "A".into(),
        content: "".into(),
        node_type: NodeType::Concept,
      })
      .await
      .unwrap();
    let b = svc
      .create_node(NewNode {
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id.clone()),
        title: "B".into(),
        content: "".into(),
        node_type: NodeType::Concept,
      })
      .await
      .unwrap();
    let moved = svc
      .update_node(
        &a.id,
        NodePatch {
          parent: Some(b.id.clone()),
          ..Default::default()
        },
      )
      .await
      .unwrap();
    assert_eq!(moved.parent, Some(b.id));
  }

  #[tokio::test]
  async fn reparent_rejects_cycle() {
    let (_tmp, svc) = fixture().await;
    let topic = svc
      .create_topic(NewTopic {
        title: "T".into(),
        slug: None,
      })
      .await
      .unwrap();
    let parent = svc
      .create_node(NewNode {
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id.clone()),
        title: "P".into(),
        content: "".into(),
        node_type: NodeType::Concept,
      })
      .await
      .unwrap();
    let child = svc
      .create_node(NewNode {
        topic: topic.id.clone(),
        parent: Some(parent.id.clone()),
        title: "C".into(),
        content: "".into(),
        node_type: NodeType::Concept,
      })
      .await
      .unwrap();
    let res = svc
      .update_node(
        &parent.id,
        NodePatch {
          parent: Some(child.id),
          ..Default::default()
        },
      )
      .await;
    assert!(matches!(res, Err(ForestError::InvalidInput(_))));
  }

  #[tokio::test]
  async fn reparent_rejects_topic_root() {
    let (_tmp, svc) = fixture().await;
    let topic = svc
      .create_topic(NewTopic {
        title: "T".into(),
        slug: None,
      })
      .await
      .unwrap();
    let other = svc
      .create_node(NewNode {
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id.clone()),
        title: "X".into(),
        content: "".into(),
        node_type: NodeType::Concept,
      })
      .await
      .unwrap();
    let res = svc
      .update_node(
        &topic.root_node_id,
        NodePatch {
          parent: Some(other.id),
          ..Default::default()
        },
      )
      .await;
    assert!(matches!(res, Err(ForestError::InvalidInput(_))));
  }

  #[tokio::test]
  async fn delete_node_removes_from_index() {
    let (_tmp, svc) = fixture().await;
    let topic = svc
      .create_topic(NewTopic {
        title: "Test".into(),
        slug: None,
      })
      .await
      .unwrap();
    let node = svc
      .create_node(NewNode {
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id),
        title: "Doomed".into(),
        content: "byebye".into(),
        node_type: NodeType::Concept,
      })
      .await
      .unwrap();

    svc.delete_node(&node.id).await.unwrap();
    let hits = svc.search("byebye", None, 10).await.unwrap();
    assert!(hits.is_empty());
  }

  #[tokio::test]
  async fn delete_topic_unindexes_all_nodes() {
    let (_tmp, svc) = fixture().await;
    let topic = svc
      .create_topic(NewTopic {
        title: "Doomed".into(),
        slug: None,
      })
      .await
      .unwrap();
    for title in ["A", "B", "C"] {
      svc
        .create_node(NewNode {
          topic: topic.id.clone(),
          parent: Some(topic.root_node_id),
          title: title.into(),
          content: format!("uniquephrase{title}"),
          node_type: NodeType::Concept,
        })
        .await
        .unwrap();
    }
    svc.delete_topic(&topic.id).await.unwrap();
    let hits = svc.search("uniquephrase", None, 10).await.unwrap();
    assert!(hits.is_empty(), "all nodes unindexed");
  }

  #[tokio::test]
  async fn watcher_loop_indexes_external_writes() {
    let tmp = TempDir::new().unwrap();
    let repo = Arc::new(FsRepository::open(tmp.path()).await.unwrap());
    let index = Arc::new(SqliteIndex::open_in_memory().await.unwrap());
    let downloader = ModelDownloader::new(tmp.path().join("models"));
    let svc = Arc::new(ForestService::new(
      repo.clone(),
      index.clone(),
      Arc::new(StubEmbedder::new(EMBED_DIM)),
      EmbedMode::Stub,
      downloader,
      Arc::new(StubProposer::new()),
      AgentConfig::default(),
      None,
    ));

    let topic = svc
      .create_topic(NewTopic {
        title: "Test".into(),
        slug: None,
      })
      .await
      .unwrap();

    let handle = repo.watch().expect("watcher start");
    svc.clone().spawn_watcher(handle.events);
    tokio::time::sleep(Duration::from_millis(700)).await;

    let now = Utc::now();
    let id = NodeId::new();
    let path = tmp
      .path()
      .join(topic.id.as_str())
      .join(format!("external--{id}.md"));
    let yaml = format!(
      "---\nid: {id}\ntopic: {}\nparent: {}\ntype: concept\ntitle: External\nlinks: []\ncreated_at: {}\nupdated_at: {}\n---\n\nbody-from-vscode\n",
      topic.id,
      topic.root_node_id,
      now.to_rfc3339(),
      now.to_rfc3339()
    );
    tokio::fs::write(&path, yaml).await.unwrap();

    let mut found = false;
    for _ in 0..40 {
      tokio::time::sleep(Duration::from_millis(100)).await;
      let hits = svc.search("body-from-vscode", None, 10).await.unwrap();
      if hits.iter().any(|h| h.id == id) {
        found = true;
        break;
      }
    }
    assert!(found, "external write should appear in search via watcher loop");

    tokio::fs::remove_file(&path).await.unwrap();
    let mut gone = false;
    for _ in 0..40 {
      tokio::time::sleep(Duration::from_millis(100)).await;
      let hits = svc.search("body-from-vscode", None, 10).await.unwrap();
      if !hits.iter().any(|h| h.id == id) {
        gone = true;
        break;
      }
    }
    assert!(gone, "external delete should remove from index");
    let _ = timeout(Duration::from_millis(10), async {}).await;
  }

  #[tokio::test]
  async fn rebuild_index_recovers_from_wipe() {
    let (_tmp, svc) = fixture().await;
    let topic = svc
      .create_topic(NewTopic {
        title: "Recover".into(),
        slug: None,
      })
      .await
      .unwrap();
    svc
      .create_node(NewNode {
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id),
        title: "Inner".into(),
        content: "phrase findme".into(),
        node_type: NodeType::Concept,
      })
      .await
      .unwrap();

    let fresh = Arc::new(SqliteIndex::open_in_memory().await.unwrap());
    // Reuse a fresh stub proposer rather than trying to extract the
    // active one from behind the RwLock — the test only cares about
    // index reconstruction; the agent path isn't exercised here.
    let (repo_arc, embedder, downloader) = match Arc::try_unwrap(svc) {
      Ok(s) => (s.repo, s.embedder, s.downloader),
      Err(s) => (s.repo.clone(), s.embedder.clone(), s.downloader.clone()),
    };
    let svc2 = ForestService::new(
      repo_arc,
      fresh,
      embedder,
      EmbedMode::Stub,
      downloader,
      Arc::new(StubProposer::new()),
      AgentConfig::default(),
      None,
    );
    svc2.rebuild_index().await.unwrap();
    let hits = svc2.search("findme", None, 10).await.unwrap();
    assert!(hits.iter().any(|h| h.title == "Inner"));
  }

  #[tokio::test]
  async fn embed_worker_drains_pending_jobs() {
    let (_tmp, svc) = fixture().await;
    let topic = svc
      .create_topic(NewTopic {
        title: "Embed".into(),
        slug: None,
      })
      .await
      .unwrap();
    svc
      .create_node(NewNode {
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id),
        title: "Backprop".into(),
        content: "Gradients flow backwards.".into(),
        node_type: NodeType::Concept,
      })
      .await
      .unwrap();

    // Two nodes pending: root + Backprop.
    let initial = svc.index.pending_embed_jobs(10).await.unwrap();
    assert_eq!(initial.len(), 2);

    svc.clone().spawn_embed_worker();

    // Worker should drain the queue within a couple of ticks.
    let mut drained = false;
    for _ in 0..30 {
      tokio::time::sleep(Duration::from_millis(50)).await;
      let p = svc.index.pending_embed_jobs(10).await.unwrap();
      if p.is_empty() {
        drained = true;
        break;
      }
    }
    assert!(drained, "embed worker should drain pending jobs");

    let status = svc.index_status().await.unwrap();
    assert_eq!(status.embed_pending, 0);
    assert!(status.embed_available);
  }

  #[tokio::test]
  async fn hybrid_search_returns_vec_only_match_when_fts_misses() {
    // With the StubEmbedder, identical text → identical vector. So if
    // we put a node whose content shares no word with the query but
    // whose *title* equals the query, the vec arm will recall it (the
    // node's text contains the same title), even though FTS would
    // recall it too. To make the test truly distinguishing, give the
    // content unique-to-vec text and query on that text.
    //
    // Stub vectors are not semantic — but the hybrid search path is
    // still exercised: FTS hit on body word, vec path hits because the
    // query embed equals the node embed when the input text is the
    // same.
    let (_tmp, svc) = fixture().await;
    let topic = svc
      .create_topic(NewTopic { title: "Hybrid".into(), slug: None })
      .await
      .unwrap();
    let n = svc
      .create_node(NewNode {
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id),
        title: "Backprop".into(),
        content: "Gradient descent step".into(),
        node_type: NodeType::Concept,
      })
      .await
      .unwrap();
    // Drain embed jobs so search_vec has data to look at.
    svc.clone().spawn_embed_worker();
    for _ in 0..30 {
      tokio::time::sleep(Duration::from_millis(50)).await;
      let p = svc.index.pending_embed_jobs(10).await.unwrap();
      if p.is_empty() {
        break;
      }
    }
    let hits = svc.search("Gradient", None, 10).await.unwrap();
    assert!(hits.iter().any(|h| h.id == n.id));
  }

  #[tokio::test]
  async fn model_status_reports_missing_until_files_present() {
    let (tmp, svc) = fixture().await;
    let status = svc.model_status().await.unwrap();
    assert_eq!(status.embed_mode, "stub");
    assert!(!status.present);
    assert!(status.dir.starts_with(tmp.path()));
    assert_eq!(status.files.len(), EMBEDDING_MODEL_FILES.len());
    assert!(status.files.iter().all(|f| !f.present));

    // Drop dummy files into the model dir; status flips to present.
    tokio::fs::create_dir_all(&status.dir).await.unwrap();
    for name in EMBEDDING_MODEL_FILES {
      tokio::fs::write(status.dir.join(name), b"\0").await.unwrap();
    }
    let status2 = svc.model_status().await.unwrap();
    assert!(status2.present);
    assert!(status2.files.iter().all(|f| f.present));
  }

  #[tokio::test]
  async fn search_falls_back_to_fts_when_embedder_unavailable() {
    let (_tmp, svc) = fixture_no_embed().await;
    let topic = svc
      .create_topic(NewTopic { title: "FTSOnly".into(), slug: None })
      .await
      .unwrap();
    let n = svc
      .create_node(NewNode {
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id),
        title: "Concept".into(),
        content: "uniqueword12345".into(),
        node_type: NodeType::Concept,
      })
      .await
      .unwrap();
    let hits = svc.search("uniqueword12345", None, 10).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, n.id);
    let status = svc.index_status().await.unwrap();
    assert!(!status.embed_available);
  }
}
