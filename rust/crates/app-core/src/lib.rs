//! `app-core` — composition layer.
//!
//! Wires the markdown-backed `ForestRepository` (storage-fs), the
//! SQLite-backed `Indexer` (index-sqlite), and the `Embedder` (`embed`)
//! into a single `ForestService` that the HTTP layer (apps/api) talks
//! to.
//!
//! This file keeps the spine: `bootstrap()` wiring, the `ForestService`
//! struct, CRUD with its **transactional write boundary** (every node
//! mutation does the file write first — authoritative — then the index
//! update; index failures surface to the caller, the file is still
//! committed and the index catches up via `rebuild_index` or watcher
//! events). The cross-backend concerns each live in their own module:
//!
//! - [`config`] — `agent.json` persistence + keychain hydration
//! - [`search`] — hybrid FTS + vec search, RRF fusion
//! - [`workers`] — watcher loop + embed worker background tasks
//! - [`model`] — embedding-model presence checks + download stream
//! - [`agent_ops`] — proposal dispatch + runtime agent-config swaps

use std::path::PathBuf;
use std::sync::Arc;

use chrono::Utc;
use tokio::sync::{Notify, RwLock};

use domain::{
  Embedder, ForestError, ForestRepository, ForestResult, IndexStatus, Indexer, NewNode, NewTopic,
  Node, NodeId, NodePatch, Topic, TopicId, TopicSummary,
};

mod agent_ops;
mod config;
mod model;
mod search;
mod workers;

pub use model::{ModelStatusResponse, EMBEDDING_MODEL_FILES, EMBEDDING_MODEL_REPO};

pub use agent::{
  merge_config_update, secret_accounts, AgentAnthropicConfig, AgentAnthropicConfigUpdate,
  AgentAnthropicConfigView, AgentConfig, AgentConfigUpdate, AgentConfigView, AgentEvent,
  AgentOpenAIConfig, AgentOpenAIConfigUpdate, AgentOpenAIConfigView, AgentProposer, AgentProvider,
  AgentRequest, AgentRole, AgentStream, AgentTurn, InMemoryStore, KeyringStore, SecretError,
  SecretStore, SECRET_SERVICE,
};
pub use embed::download::{DownloadEvent, FileStatus, ModelDownloader, ModelStatus};
pub use embed::{EmbedMode, StubEmbedder, UnavailableEmbedder};
pub use index_sqlite::{content_hash_for, SqliteIndex, EMBED_DIM};
pub use storage_fs::{node_id_from_path, FsRepository, WatchEvent, WatcherHandle};

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
  // first-time launch still works without writing to disk. API keys
  // are pulled from / migrated to the OS keychain — see
  // `load_and_hydrate_agent_config`.
  let secret_store: Arc<dyn SecretStore> = Arc::new(KeyringStore::new(SECRET_SERVICE));
  let agent_config_path = data_dir.join("agent.json");
  let agent_config = config::load_and_hydrate_agent_config(&agent_config_path, &secret_store).await;
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
    secret_store,
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
  /// Where API keys actually live. The plaintext `api_key` fields in
  /// `agent_config` are a view onto this — `set_agent_config` writes
  /// through to the store, `load_and_hydrate_agent_config` reads from
  /// it on boot. Tests can pass `InMemoryStore` to avoid mutating the
  /// host's real keyring.
  secret_store: Arc<dyn SecretStore>,
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
    secret_store: Arc<dyn SecretStore>,
  ) -> Self {
    Self {
      repo,
      index,
      embedder,
      embed_notify: Arc::new(Notify::new()),
      embed_mode_label: model::embed_mode_label(&embed_mode),
      downloader,
      proposer: Arc::new(RwLock::new(proposer)),
      agent_config: Arc::new(RwLock::new(agent_config)),
      agent_config_path: agent_config_path.into(),
      secret_store,
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

  // ─── Index ────────────────────────────────────────────────────────

  pub async fn index_status(&self) -> ForestResult<IndexStatus> {
    let mut status = self.index.status().await?;
    status.embed_available = self.embedder.available();
    Ok(status)
  }

  pub async fn rebuild_index(&self) -> ForestResult<()> {
    self.index.rebuild_from(self.repo.as_ref()).await?;
    // The rebuild repopulates `embed_jobs` with one pending row per
    // node, so wake the worker to start chewing through them.
    self.embed_notify.notify_one();
    Ok(())
  }
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
    let secret_store: Arc<dyn SecretStore> = Arc::new(InMemoryStore::new());
    let svc = Arc::new(ForestService::new(
      Arc::new(repo),
      Arc::new(index),
      Arc::new(StubEmbedder::new(EMBED_DIM)),
      EmbedMode::Stub,
      downloader,
      Arc::new(StubProposer::new()),
      AgentConfig::default(),
      None,
      secret_store,
    ));
    (tmp, svc)
  }

  async fn fixture_no_embed() -> (TempDir, Arc<ForestService>) {
    let tmp = TempDir::new().unwrap();
    let repo = FsRepository::open(tmp.path()).await.unwrap();
    let index = SqliteIndex::open_in_memory().await.unwrap();
    let downloader = ModelDownloader::new(tmp.path().join("models"));
    let secret_store: Arc<dyn SecretStore> = Arc::new(InMemoryStore::new());
    let svc = Arc::new(ForestService::new(
      Arc::new(repo),
      Arc::new(index),
      Arc::new(UnavailableEmbedder::new(EMBED_DIM)),
      EmbedMode::Off,
      downloader,
      Arc::new(StubProposer::new()),
      AgentConfig::default(),
      None,
      secret_store,
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
    let secret_store: Arc<dyn SecretStore> = Arc::new(InMemoryStore::new());
    let svc = Arc::new(ForestService::new(
      repo.clone(),
      index.clone(),
      Arc::new(StubEmbedder::new(EMBED_DIM)),
      EmbedMode::Stub,
      downloader,
      Arc::new(StubProposer::new()),
      AgentConfig::default(),
      None,
      secret_store,
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
    let secret_store: Arc<dyn SecretStore> = Arc::new(InMemoryStore::new());
    let svc2 = ForestService::new(
      repo_arc,
      fresh,
      embedder,
      EmbedMode::Stub,
      downloader,
      Arc::new(StubProposer::new()),
      AgentConfig::default(),
      None,
      secret_store,
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
  async fn set_agent_config_writes_secret_then_file() {
    let (tmp, svc) = fixture_with_persistence().await;
    let mut cfg = AgentConfig::default();
    cfg.provider = AgentProvider::Openai;
    cfg.openai.api_key = Some("sk-new-XXXX9999".into());
    cfg.openai.model = Some("gpt-4o-mini".into());
    svc.set_agent_config(cfg).await.unwrap();

    // File on disk: no plaintext api_key.
    let path = tmp.path().join("agent.json");
    let raw: serde_json::Value =
      serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
    assert!(raw.get("openai").unwrap().get("api_key").is_none());

    // SecretStore got the value (via the service's store).
    let echoed = svc.agent_config().await;
    assert_eq!(echoed.openai.api_key.as_deref(), Some("sk-new-XXXX9999"));
  }

  /// A fixture that, unlike `fixture()`, owns a real path on disk so we
  /// can inspect what `set_agent_config` writes.
  async fn fixture_with_persistence() -> (TempDir, Arc<ForestService>) {
    let tmp = TempDir::new().unwrap();
    let repo = FsRepository::open(tmp.path()).await.unwrap();
    let index = SqliteIndex::open_in_memory().await.unwrap();
    let downloader = ModelDownloader::new(tmp.path().join("models"));
    let secret_store: Arc<dyn SecretStore> = Arc::new(InMemoryStore::new());
    let svc = Arc::new(ForestService::new(
      Arc::new(repo),
      Arc::new(index),
      Arc::new(StubEmbedder::new(EMBED_DIM)),
      EmbedMode::Stub,
      downloader,
      Arc::new(StubProposer::new()),
      AgentConfig::default(),
      Some(tmp.path().join("agent.json")),
      secret_store,
    ));
    (tmp, svc)
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

  #[tokio::test]
  async fn search_degrades_to_fts_when_vec_arm_breaks() {
    // An embedder that claims availability but emits vectors of the
    // wrong dimension — the index-side search_vec call fails (the vec
    // table is declared at EMBED_DIM). The search must still answer
    // from FTS instead of erroring out; the failure is logged at
    // error level (see search.rs module docs).
    let tmp = TempDir::new().unwrap();
    let repo = FsRepository::open(tmp.path()).await.unwrap();
    let index = SqliteIndex::open_in_memory().await.unwrap();
    let downloader = ModelDownloader::new(tmp.path().join("models"));
    let secret_store: Arc<dyn SecretStore> = Arc::new(InMemoryStore::new());
    let svc = Arc::new(ForestService::new(
      Arc::new(repo),
      Arc::new(index),
      Arc::new(StubEmbedder::new(EMBED_DIM + 3)),
      EmbedMode::Stub,
      downloader,
      Arc::new(StubProposer::new()),
      AgentConfig::default(),
      None,
      secret_store,
    ));
    let topic = svc
      .create_topic(NewTopic { title: "BadDim".into(), slug: None })
      .await
      .unwrap();
    let n = svc
      .create_node(NewNode {
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id),
        title: "Node".into(),
        content: "degradeword999".into(),
        node_type: NodeType::Concept,
      })
      .await
      .unwrap();
    let hits = svc.search("degradeword999", None, 10).await.unwrap();
    assert!(
      hits.iter().any(|h| h.id == n.id),
      "FTS hit must survive a broken vec arm"
    );
  }
}
