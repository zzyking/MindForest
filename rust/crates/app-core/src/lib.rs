//! `app-core` — composition layer.
//!
//! Wires the markdown-backed `ForestRepository` (storage-fs) and the
//! SQLite-backed `Indexer` (index-sqlite) into a single `ForestService`
//! that the HTTP layer (apps/api) talks to. Owns three things that
//! span both backends:
//!
//! - **Transactional write boundary**: every node mutation does the file
//!   write first (authoritative), then the index update. Index failures
//!   are surfaced to the caller; the file is still committed and the
//!   index will catch up via `rebuild_index` or watcher events.
//! - **Watcher loop**: consumes `WatchEvent`s from storage-fs and applies
//!   them to the index, keeping search results fresh against external
//!   edits (the user opens a `.md` in VS Code, hits save).
//! - **Search composition**: P1 just delegates to FTS; P3 will fuse FTS
//!   + vector + topic-bonus reranking here.

use std::sync::Arc;

use chrono::Utc;
use tokio::sync::mpsc;

use domain::{
  ForestError, ForestRepository, ForestResult, IndexStatus, Indexer, NewNode, NewTopic, Node,
  NodeId, NodePatch, SearchHit, Topic, TopicId, TopicSummary,
};

pub use storage_fs::{node_id_from_path, FsRepository, WatchEvent, WatcherHandle};

#[derive(Clone)]
pub struct ForestService {
  repo: Arc<dyn ForestRepository>,
  index: Arc<dyn Indexer>,
}

impl ForestService {
  pub fn new(repo: Arc<dyn ForestRepository>, index: Arc<dyn Indexer>) -> Self {
    Self { repo, index }
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
    Ok(topic)
  }

  pub async fn delete_topic(&self, id: &TopicId) -> ForestResult<()> {
    // Snapshot the topic's nodes BEFORE deletion so we know what to
    // unindex; once delete_topic runs the directory is gone.
    let nodes = self.repo.list_nodes_in_topic(id).await?;
    self.repo.delete_topic(id).await?;
    for n in nodes {
      // Best-effort: log on failure but keep going so a bad index entry
      // doesn't strand the others.
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
    node.updated_at = Utc::now();
    self.repo.write_node(&node).await?;
    self.index.upsert(&node).await?;
    Ok(node)
  }

  pub async fn delete_node(&self, id: &NodeId) -> ForestResult<()> {
    self.repo.delete_node(id).await?;
    self.index.delete(id).await?;
    Ok(())
  }

  // ─── Search ───────────────────────────────────────────────────────

  pub async fn search(
    &self,
    query: &str,
    topic: Option<&TopicId>,
    k: usize,
  ) -> ForestResult<Vec<SearchHit>> {
    // P1: FTS only. P3 will fuse vec + FTS + topic-bonus here.
    self.index.search_fts(query, topic, k).await
  }

  pub async fn index_status(&self) -> ForestResult<IndexStatus> {
    self.index.status().await
  }

  pub async fn rebuild_index(&self) -> ForestResult<()> {
    self.index.rebuild_from(self.repo.as_ref()).await
  }

  // ─── Watcher integration ──────────────────────────────────────────

  /// Spawn a background task that consumes filesystem events and keeps
  /// the index in sync. Returns a `JoinHandle`; the task ends when the
  /// stream closes (e.g., the `WatcherHandle` is dropped).
  ///
  /// FsRepository's watcher already filters our own internal writes via
  /// the RecentWrites suppression layer, so events arriving here are
  /// almost always external edits worth re-indexing.
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
        // Skip non-node files (`_topic.md`, unknown patterns) — those don't
        // affect search results in P1.
        let Some(id) = node_id_from_path(&path) else {
          return Ok(());
        };
        match self.repo.read_node(&id).await {
          Ok(node) => self.index.upsert(&node).await?,
          Err(ForestError::NodeNotFound(_)) => {
            // File disappeared between event delivery and our read —
            // treat as deletion so the index doesn't keep a ghost.
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
}

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::Utc;
  use domain::NodeType;
  use index_sqlite::SqliteIndex;
  use std::time::Duration;
  use tempfile::TempDir;
  use tokio::time::timeout;

  async fn fixture() -> (TempDir, Arc<ForestService>) {
    let tmp = TempDir::new().unwrap();
    let repo = FsRepository::open(tmp.path()).await.unwrap();
    let index = SqliteIndex::open_in_memory().await.unwrap();
    let svc = Arc::new(ForestService::new(Arc::new(repo), Arc::new(index)));
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
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, node.id);
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
    assert_eq!(stale.len(), 0, "old content should not match");
    let fresh = svc.search("version two", None, 10).await.unwrap();
    assert_eq!(fresh.len(), 1);
    assert_eq!(fresh[0].title, "New");
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
    assert_eq!(hits.len(), 0);
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
    assert_eq!(hits.len(), 0, "all nodes unindexed");
  }

  #[tokio::test]
  async fn watcher_loop_indexes_external_writes() {
    let tmp = TempDir::new().unwrap();
    let repo = Arc::new(FsRepository::open(tmp.path()).await.unwrap());
    let index = Arc::new(SqliteIndex::open_in_memory().await.unwrap());
    let svc = Arc::new(ForestService::new(repo.clone(), index.clone()));

    // Seed a topic via the service (so root is indexed).
    let topic = svc
      .create_topic(NewTopic {
        title: "Test".into(),
        slug: None,
      })
      .await
      .unwrap();

    // Start the watcher loop.
    let handle = repo.watch().expect("watcher start");
    svc.clone().spawn_watcher(handle.events);

    // Drain self-events from create_topic.
    tokio::time::sleep(Duration::from_millis(700)).await;

    // External write — bypass the service to simulate the user editing
    // a .md directly in their text editor.
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

    // Wait for the watcher loop to reflect it. The 200ms debounce + index
    // upsert bounds the upper end; allow some slack.
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

    // External delete should unindex.
    tokio::fs::remove_file(&path).await.unwrap();
    let mut gone = false;
    for _ in 0..40 {
      tokio::time::sleep(Duration::from_millis(100)).await;
      let hits = svc.search("body-from-vscode", None, 10).await.unwrap();
      if hits.is_empty() {
        gone = true;
        break;
      }
    }
    assert!(gone, "external delete should remove from index");

    // Avoid an unused warning.
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

    // Wipe the index by rebuilding into a fresh one.
    let fresh = Arc::new(SqliteIndex::open_in_memory().await.unwrap());
    let repo_arc: Arc<dyn ForestRepository> = match Arc::try_unwrap(svc) {
      Ok(s) => s.repo,
      Err(s) => s.repo.clone(),
    };
    let svc2 = ForestService::new(repo_arc, fresh);
    svc2.rebuild_index().await.unwrap();
    let hits = svc2.search("findme", None, 10).await.unwrap();
    assert_eq!(hits.len(), 1);
  }
}
