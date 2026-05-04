//! `storage-fs` — markdown source-of-truth backend for MindForest.
//!
//! Layout:
//!
//! ```text
//! vault/
//! ├─ deep-learning/
//! │  ├─ _topic.md                       pure topic metadata + bulletin (body)
//! │  ├─ deep-learning--01HV6Q...md      root node — a regular node file
//! │  ├─ backprop--01HV6R...md           child node
//! │  └─ chain-rule--01HV6S...md
//! └─ linear-algebra/
//!    └─ ...
//! ```
//!
//! Files are the authoritative state. Every node — including the topic
//! root — uses the same `<slug>--<ulid>.md` convention and the same
//! frontmatter shape, so read/write paths are uniform with no `is_root`
//! branches. `_topic.md` is *not* a node; it carries title + root pointer
//! + bulletin and is read only via `get_topic` / `list_topics`.
//!
//! The `id → (topic, path)` cache is rebuilt lazily on miss; the watcher
//! (see [`watch_vault`]) keeps it fresh against external edits.

mod frontmatter;
mod paths;
mod suppression;
mod watcher;

pub use watcher::{watch_vault, WatchEvent, WatcherHandle};

/// Extract the [`NodeId`] from a vault file path.
///
/// Returns `None` for `_topic.md` (topic-level metadata, not a node) and
/// for any file that doesn't match the `<slug>--<ulid>.md` convention.
/// Used by app-core's watcher loop to decide whether a filesystem event
/// pertains to an indexable node.
pub fn node_id_from_path(path: &Path) -> Option<NodeId> {
  let name = path.file_name().and_then(|n| n.to_str())?;
  if name == paths::TOPIC_FILE {
    return None;
  }
  paths::id_from_filename(name)
}

use crate::suppression::RecentWrites;

use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use tokio::fs;
use tokio::sync::RwLock;

use domain::{
  ForestError, ForestRepository, ForestResult, NewTopic, Node, NodeId, NodeType, Topic, TopicId,
  TopicSummary,
};

use crate::frontmatter::{parse_node_front, parse_topic_front, NodeFront, TopicFront};
use crate::paths::{id_from_filename, new_node_filename, slugify, topic_dir, topic_file, TOPIC_FILE};

#[derive(Debug, Clone)]
pub struct FsRepository {
  inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
  vault: PathBuf,
  /// node id → on-disk location.
  cache: RwLock<HashMap<NodeId, NodeLocation>>,
  /// topic id → its root node id. Used to guard delete_node against
  /// removing a topic's root (which would orphan `_topic.md`).
  topic_roots: RwLock<HashMap<TopicId, NodeId>>,
  /// Shared registry that lets the watcher drop self-write events.
  recent_writes: Arc<RecentWrites>,
}

#[derive(Debug, Clone)]
struct NodeLocation {
  topic: TopicId,
  path: PathBuf,
}

impl FsRepository {
  /// Open (creating if missing) a vault at `vault`.
  pub async fn open(vault: impl Into<PathBuf>) -> ForestResult<Self> {
    let vault: PathBuf = vault.into();
    fs::create_dir_all(&vault)
      .await
      .map_err(|e| ForestError::Storage(format!("create vault {vault:?}: {e}")))?;
    Ok(Self {
      inner: Arc::new(Inner {
        vault,
        cache: RwLock::new(HashMap::new()),
        topic_roots: RwLock::new(HashMap::new()),
        recent_writes: Arc::new(RecentWrites::default()),
      }),
    })
  }

  pub fn vault_dir(&self) -> &Path {
    &self.inner.vault
  }

  /// Begin watching the vault for filesystem changes. The returned
  /// handle's events stream filters out this repo's own internal writes
  /// via the shared RecentWrites registry, so consumers see only
  /// external edits (and rename'd-away old paths during title changes).
  pub fn watch(&self) -> ForestResult<WatcherHandle> {
    watcher::watch_vault_with_suppression(
      &self.inner.vault,
      Some(Arc::clone(&self.inner.recent_writes)),
    )
  }

  /// Walk all topics, repopulating the in-memory caches from disk.
  pub async fn rebuild_cache(&self) -> ForestResult<()> {
    let mut new_cache: HashMap<NodeId, NodeLocation> = HashMap::new();
    let mut new_roots: HashMap<TopicId, NodeId> = HashMap::new();
    let mut entries = fs::read_dir(&self.inner.vault)
      .await
      .map_err(|e| ForestError::Storage(format!("read_dir {:?}: {e}", self.inner.vault)))?;
    while let Some(entry) = entries
      .next_entry()
      .await
      .map_err(|e| ForestError::Storage(format!("read_dir entry: {e}")))?
    {
      let path = entry.path();
      if !path.is_dir() {
        continue;
      }
      let dir_name = match path.file_name().and_then(|n| n.to_str()) {
        Some(n) if !n.starts_with('.') => n.to_string(),
        _ => continue,
      };
      let Ok(topic) = TopicId::new(dir_name) else { continue };
      scan_topic_dir(&topic, &path, &mut new_cache, &mut new_roots).await;
    }
    *self.inner.cache.write().await = new_cache;
    *self.inner.topic_roots.write().await = new_roots;
    Ok(())
  }

  async fn locate(&self, id: &NodeId) -> ForestResult<NodeLocation> {
    if let Some(loc) = self.inner.cache.read().await.get(id).cloned() {
      return Ok(loc);
    }
    self.rebuild_cache().await?;
    self
      .inner
      .cache
      .read()
      .await
      .get(id)
      .cloned()
      .ok_or(ForestError::NodeNotFound(*id))
  }

  async fn topic_root_id(&self, topic: &TopicId) -> ForestResult<NodeId> {
    if let Some(id) = self.inner.topic_roots.read().await.get(topic).copied() {
      return Ok(id);
    }
    // Cold path: read _topic.md directly and cache.
    let path = topic_file(&self.inner.vault, topic);
    let (front, _) = read_topic_file(&path).await.map_err(|e| match e {
      ForestError::Storage(msg) if msg.contains("No such file") => {
        ForestError::TopicNotFound(topic.clone())
      }
      other => other,
    })?;
    self
      .inner
      .topic_roots
      .write()
      .await
      .insert(topic.clone(), front.root_node_id);
    Ok(front.root_node_id)
  }
}

async fn scan_topic_dir(
  topic: &TopicId,
  topic_path: &Path,
  cache_out: &mut HashMap<NodeId, NodeLocation>,
  roots_out: &mut HashMap<TopicId, NodeId>,
) {
  let mut files = match fs::read_dir(topic_path).await {
    Ok(f) => f,
    Err(e) => {
      tracing::warn!("read_dir {topic_path:?}: {e}");
      return;
    }
  };
  while let Ok(Some(entry)) = files.next_entry().await {
    let path = entry.path();
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
    if !name.ends_with(".md") {
      continue;
    }
    if name == TOPIC_FILE {
      // Topic metadata — extract root_node_id, don't add to node cache.
      match read_topic_file(&path).await {
        Ok((front, _)) => {
          roots_out.insert(topic.clone(), front.root_node_id);
        }
        Err(e) => tracing::warn!("malformed {path:?}: {e}"),
      }
      continue;
    }
    let Some(id) = id_from_filename(name) else { continue };
    cache_out.insert(
      id,
      NodeLocation {
        topic: topic.clone(),
        path,
      },
    );
  }
}

async fn read_node_file(path: &Path) -> ForestResult<(NodeFront, String)> {
  let text = fs::read_to_string(path)
    .await
    .map_err(|e| ForestError::Storage(format!("read {path:?}: {e}")))?;
  let (yaml, body) = frontmatter::split_frontmatter(&text)?;
  let front = parse_node_front(yaml)?;
  Ok((front, body.trim_end_matches('\n').to_string()))
}

async fn read_topic_file(path: &Path) -> ForestResult<(TopicFront, String)> {
  let text = fs::read_to_string(path)
    .await
    .map_err(|e| ForestError::Storage(format!("read {path:?}: {e}")))?;
  let (yaml, body) = frontmatter::split_frontmatter(&text)?;
  let front = parse_topic_front(yaml)?;
  Ok((front, body.trim_end_matches('\n').to_string()))
}

/// Atomic write: tempfile in same dir + fsync + rename. Crash at any
/// point leaves the previous file intact. After a successful persist,
/// records `(path, post-write mtime)` in `recent_writes` so the watcher
/// can drop the resulting self-event.
async fn atomic_write(
  path: &Path,
  contents: &str,
  recent_writes: &Arc<RecentWrites>,
) -> ForestResult<()> {
  let path = path.to_path_buf();
  let contents = contents.to_owned();
  let recent = Arc::clone(recent_writes);
  tokio::task::spawn_blocking(move || -> ForestResult<()> {
    use std::io::Write;
    let parent = path
      .parent()
      .ok_or_else(|| ForestError::Storage(format!("path has no parent: {path:?}")))?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)
      .map_err(|e| ForestError::Storage(format!("tempfile in {parent:?}: {e}")))?;
    tmp
      .as_file_mut()
      .write_all(contents.as_bytes())
      .map_err(|e| ForestError::Storage(format!("write tempfile: {e}")))?;
    tmp
      .as_file_mut()
      .sync_all()
      .map_err(|e| ForestError::Storage(format!("fsync: {e}")))?;
    tmp
      .persist(&path)
      .map_err(|e| ForestError::Storage(format!("persist {path:?}: {e}")))?;

    // Best-effort mtime read + canonicalize — failure to read just means
    // the watcher event for this write won't be suppressed (consumer
    // still dedupes by content hash). We don't fail the write for it.
    //
    // Canonicalization is required: macOS FSEvents reports paths through
    // `/private/var/...` while user-supplied paths often go through the
    // `/var → /private/var` symlink. Storing the canonical form keys
    // RecentWrites consistently across both sides.
    let canonical = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
    if let Ok(meta) = std::fs::metadata(&canonical) {
      if let Ok(mtime) = meta.modified() {
        recent.record(canonical, mtime);
      }
    }
    Ok(())
  })
  .await
  .map_err(|e| ForestError::Storage(format!("join: {e}")))?
}

#[async_trait]
impl ForestRepository for FsRepository {
  async fn list_topics(&self) -> ForestResult<Vec<TopicSummary>> {
    let mut topics = Vec::new();
    let mut entries = fs::read_dir(&self.inner.vault)
      .await
      .map_err(|e| ForestError::Storage(format!("read_dir vault: {e}")))?;
    while let Some(entry) = entries
      .next_entry()
      .await
      .map_err(|e| ForestError::Storage(format!("entry: {e}")))?
    {
      let path = entry.path();
      if !path.is_dir() {
        continue;
      }
      let dir_name = match path.file_name().and_then(|n| n.to_str()) {
        Some(n) if !n.starts_with('.') => n.to_string(),
        _ => continue,
      };
      let Ok(topic_id) = TopicId::new(dir_name) else { continue };
      let topic_path = topic_file(&self.inner.vault, &topic_id);
      let (front, _) = match read_topic_file(&topic_path).await {
        Ok(x) => x,
        Err(_) => continue,
      };
      let count = count_node_files(&path).await;
      topics.push(TopicSummary {
        id: topic_id,
        title: front.title,
        node_count: count,
        updated_at: front.updated_at,
      });
    }
    topics.sort_by(|a, b| a.title.cmp(&b.title));
    Ok(topics)
  }

  async fn get_topic(&self, id: &TopicId) -> ForestResult<Topic> {
    let path = topic_file(&self.inner.vault, id);
    let (front, body) = read_topic_file(&path).await.map_err(|e| match e {
      ForestError::Storage(msg) if msg.contains("No such file") => {
        ForestError::TopicNotFound(id.clone())
      }
      other => other,
    })?;
    Ok(Topic {
      id: id.clone(),
      title: front.title,
      root_node_id: front.root_node_id,
      bulletin: body,
      created_at: front.created_at,
      updated_at: front.updated_at,
    })
  }

  async fn create_topic(&self, new_topic: NewTopic) -> ForestResult<Topic> {
    let title = new_topic.title.trim().to_string();
    if title.is_empty() {
      return Err(ForestError::InvalidInput(
        "topic title must not be empty".into(),
      ));
    }
    let slug = match new_topic.slug {
      Some(s) => s,
      None => {
        let s = slugify(&title);
        if s.is_empty() {
          "untitled".to_string()
        } else {
          s
        }
      }
    };
    let id = TopicId::new(slug)?;
    let dir = topic_dir(&self.inner.vault, &id);
    if dir.exists() {
      return Err(ForestError::TopicAlreadyExists(id));
    }
    fs::create_dir_all(&dir)
      .await
      .map_err(|e| ForestError::Storage(format!("create_dir {dir:?}: {e}")))?;
    let now = Utc::now();
    let root_id = NodeId::new();

    // 1. _topic.md — pure topic metadata. Body = bulletin (empty initially).
    let topic_front = TopicFront {
      slug: id.clone(),
      title: title.clone(),
      root_node_id: root_id,
      created_at: now,
      updated_at: now,
    };
    let topic_path = topic_file(&self.inner.vault, &id);
    atomic_write(
      &topic_path,
      &frontmatter::render_topic_file(&topic_front, "")?,
      &self.inner.recent_writes,
    )
    .await?;

    // 2. Root node — a regular node file, no special-case shape.
    let root_front = NodeFront {
      id: root_id,
      topic: id.clone(),
      parent: None,
      node_type: NodeType::Concept,
      title: title.clone(),
      links: vec![],
      created_at: now,
      updated_at: now,
      color: None,
    };
    let root_path = dir.join(new_node_filename(&title, &root_id));
    atomic_write(
      &root_path,
      &frontmatter::render_node_file(&root_front, "")?,
      &self.inner.recent_writes,
    )
    .await?;

    // Update caches.
    self.inner.cache.write().await.insert(
      root_id,
      NodeLocation {
        topic: id.clone(),
        path: root_path,
      },
    );
    self
      .inner
      .topic_roots
      .write()
      .await
      .insert(id.clone(), root_id);

    Ok(Topic {
      id,
      title,
      root_node_id: root_id,
      bulletin: String::new(),
      created_at: now,
      updated_at: now,
    })
  }

  async fn delete_topic(&self, id: &TopicId) -> ForestResult<()> {
    let dir = topic_dir(&self.inner.vault, id);
    if !dir.exists() {
      return Err(ForestError::TopicNotFound(id.clone()));
    }
    fs::remove_dir_all(&dir)
      .await
      .map_err(|e| ForestError::Storage(format!("remove_dir_all: {e}")))?;
    self
      .inner
      .cache
      .write()
      .await
      .retain(|_, loc| loc.topic != *id);
    self.inner.topic_roots.write().await.remove(id);
    Ok(())
  }

  async fn read_node(&self, id: &NodeId) -> ForestResult<Node> {
    let loc = self.locate(id).await?;
    let (front, body) = read_node_file(&loc.path).await?;
    Ok(Node {
      id: front.id,
      topic: loc.topic,
      parent: front.parent,
      node_type: front.node_type,
      title: front.title,
      content: body,
      links: front.links,
      created_at: front.created_at,
      updated_at: front.updated_at,
      color: front.color,
    })
  }

  async fn write_node(&self, node: &Node) -> ForestResult<()> {
    let dir = topic_dir(&self.inner.vault, &node.topic);
    if !dir.exists() {
      return Err(ForestError::TopicNotFound(node.topic.clone()));
    }

    let desired_path = dir.join(new_node_filename(&node.title, &node.id));
    let existing = self.inner.cache.read().await.get(&node.id).cloned();

    // If the slug derived from the title (or topic) changed, rename the file
    // first so the on-disk name stays in sync with the title. fs::rename is
    // atomic within the same filesystem; cross-topic moves are uncommon but
    // also handled (rename across dirs in the same vault). The subsequent
    // atomic_write then refreshes the body — if the rename succeeds and the
    // write fails, the file still exists at the new path with stale content,
    // and a retry will fix it; we never end up with two files for one node.
    if let Some(loc) = &existing {
      if loc.path != desired_path {
        fs::rename(&loc.path, &desired_path).await.map_err(|e| {
          ForestError::Storage(format!(
            "rename {:?} → {:?}: {e}",
            loc.path, desired_path
          ))
        })?;
      }
    }

    let nf = NodeFront {
      id: node.id,
      topic: node.topic.clone(),
      parent: node.parent,
      node_type: node.node_type,
      title: node.title.clone(),
      links: node.links.clone(),
      created_at: node.created_at,
      updated_at: node.updated_at,
      color: node.color.clone(),
    };
    atomic_write(
      &desired_path,
      &frontmatter::render_node_file(&nf, &node.content)?,
      &self.inner.recent_writes,
    )
    .await?;
    self.inner.cache.write().await.insert(
      node.id,
      NodeLocation {
        topic: node.topic.clone(),
        path: desired_path,
      },
    );
    Ok(())
  }

  async fn delete_node(&self, id: &NodeId) -> ForestResult<()> {
    let loc = self.locate(id).await?;
    // Guard: don't allow deleting a topic's root via this method;
    // _topic.md would still point to it. Use delete_topic instead.
    let root_id = self.topic_root_id(&loc.topic).await?;
    if root_id == *id {
      return Err(ForestError::InvalidInput(
        "cannot delete topic root via delete_node; use delete_topic".into(),
      ));
    }
    match fs::remove_file(&loc.path).await {
      Ok(_) => {}
      Err(e) if e.kind() == ErrorKind::NotFound => {
        return Err(ForestError::NodeNotFound(*id));
      }
      Err(e) => return Err(ForestError::Storage(format!("remove_file: {e}"))),
    }
    self.inner.cache.write().await.remove(id);
    Ok(())
  }

  async fn list_nodes_in_topic(&self, topic: &TopicId) -> ForestResult<Vec<Node>> {
    let dir = topic_dir(&self.inner.vault, topic);
    if !dir.exists() {
      return Err(ForestError::TopicNotFound(topic.clone()));
    }
    let mut nodes = Vec::new();
    let mut files = fs::read_dir(&dir)
      .await
      .map_err(|e| ForestError::Storage(format!("read_dir: {e}")))?;
    while let Some(entry) = files
      .next_entry()
      .await
      .map_err(|e| ForestError::Storage(format!("entry: {e}")))?
    {
      let path = entry.path();
      let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
      if !name.ends_with(".md") || name == TOPIC_FILE {
        continue;
      }
      match read_node_file(&path).await {
        Ok((front, body)) => nodes.push(Node {
          id: front.id,
          topic: topic.clone(),
          parent: front.parent,
          node_type: front.node_type,
          title: front.title,
          content: body,
          links: front.links,
          created_at: front.created_at,
          updated_at: front.updated_at,
          color: front.color,
        }),
        Err(e) => tracing::warn!("skipping {path:?}: {e}"),
      }
    }
    Ok(nodes)
  }
}

async fn count_node_files(dir: &Path) -> usize {
  let Ok(mut files) = fs::read_dir(dir).await else {
    return 0;
  };
  let mut count = 0usize;
  while let Ok(Some(entry)) = files.next_entry().await {
    let name = entry.file_name();
    let s = name.to_string_lossy();
    if s.ends_with(".md") && s != TOPIC_FILE {
      count += 1;
    }
  }
  count
}

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::Utc;
  use tempfile::TempDir;

  async fn fixture() -> (TempDir, FsRepository) {
    let tmp = TempDir::new().unwrap();
    let repo = FsRepository::open(tmp.path()).await.unwrap();
    (tmp, repo)
  }

  #[tokio::test]
  async fn create_topic_writes_metadata_and_root_files() {
    let (_tmp, repo) = fixture().await;
    let topic = repo
      .create_topic(NewTopic {
        title: "Deep Learning".into(),
        slug: None,
      })
      .await
      .unwrap();

    assert_eq!(topic.id.as_str(), "deep-learning");
    let dir = repo.vault_dir().join("deep-learning");
    assert!(dir.join("_topic.md").exists(), "_topic.md should exist");

    // Root node lives in its own regular `<slug>--<ulid>.md` file.
    let root_filename = format!("deep-learning--{}.md", topic.root_node_id);
    assert!(
      dir.join(&root_filename).exists(),
      "root node file should exist at {root_filename}"
    );

    let listed = repo.list_topics().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].title, "Deep Learning");
    assert_eq!(listed[0].node_count, 1, "node_count should not include _topic.md");
  }

  #[tokio::test]
  async fn get_topic_round_trip_with_bulletin() {
    let (_tmp, repo) = fixture().await;
    let created = repo
      .create_topic(NewTopic {
        title: "Linear Algebra".into(),
        slug: None,
      })
      .await
      .unwrap();
    assert_eq!(created.bulletin, "");

    let fetched = repo.get_topic(&created.id).await.unwrap();
    assert_eq!(fetched.title, "Linear Algebra");
    assert_eq!(fetched.root_node_id, created.root_node_id);
    assert_eq!(fetched.bulletin, "");
  }

  #[tokio::test]
  async fn root_node_reads_via_read_node_uniformly() {
    let (_tmp, repo) = fixture().await;
    let topic = repo
      .create_topic(NewTopic {
        title: "Test".into(),
        slug: None,
      })
      .await
      .unwrap();
    let root = repo.read_node(&topic.root_node_id).await.unwrap();
    assert_eq!(root.id, topic.root_node_id);
    assert_eq!(root.title, "Test");
    assert_eq!(root.parent, None);
    assert_eq!(root.topic, topic.id);
  }

  #[tokio::test]
  async fn write_then_read_node_round_trips() {
    let (_tmp, repo) = fixture().await;
    let topic = repo
      .create_topic(NewTopic {
        title: "Test".into(),
        slug: None,
      })
      .await
      .unwrap();

    let now = Utc::now();
    let node = Node {
      id: NodeId::new(),
      topic: topic.id.clone(),
      parent: Some(topic.root_node_id),
      node_type: NodeType::Fact,
      title: "Backpropagation".into(),
      content: "# Backprop\n\nGradient flows backwards.".into(),
      links: vec![],
      created_at: now,
      updated_at: now,
      color: None,
    };
    repo.write_node(&node).await.unwrap();

    let read = repo.read_node(&node.id).await.unwrap();
    assert_eq!(read.title, "Backpropagation");
    assert_eq!(read.parent, Some(topic.root_node_id));
    assert_eq!(read.node_type, NodeType::Fact);
    assert_eq!(read.content, "# Backprop\n\nGradient flows backwards.");
  }

  #[tokio::test]
  async fn list_nodes_returns_root_and_children() {
    let (_tmp, repo) = fixture().await;
    let topic = repo
      .create_topic(NewTopic {
        title: "Test".into(),
        slug: None,
      })
      .await
      .unwrap();
    let now = Utc::now();
    for title in ["A", "B", "C"] {
      repo
        .write_node(&Node {
          id: NodeId::new(),
          topic: topic.id.clone(),
          parent: Some(topic.root_node_id),
          node_type: NodeType::Concept,
          title: title.into(),
          content: "".into(),
          links: vec![],
          created_at: now,
          updated_at: now,
          color: None,
        })
        .await
        .unwrap();
    }
    let nodes = repo.list_nodes_in_topic(&topic.id).await.unwrap();
    assert_eq!(nodes.len(), 4);
    let mut titles: Vec<_> = nodes.iter().map(|n| n.title.clone()).collect();
    titles.sort();
    assert_eq!(titles, vec!["A", "B", "C", "Test"]);
  }

  #[tokio::test]
  async fn delete_node_removes_file_and_cache() {
    let (_tmp, repo) = fixture().await;
    let topic = repo
      .create_topic(NewTopic {
        title: "Test".into(),
        slug: None,
      })
      .await
      .unwrap();
    let now = Utc::now();
    let id = NodeId::new();
    repo
      .write_node(&Node {
        id,
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id),
        node_type: NodeType::Concept,
        title: "Doomed".into(),
        content: "".into(),
        links: vec![],
        created_at: now,
        updated_at: now,
        color: None,
      })
      .await
      .unwrap();
    repo.delete_node(&id).await.unwrap();
    assert!(matches!(
      repo.read_node(&id).await,
      Err(ForestError::NodeNotFound(_))
    ));
  }

  #[tokio::test]
  async fn delete_node_refuses_topic_root_by_id() {
    let (_tmp, repo) = fixture().await;
    let topic = repo
      .create_topic(NewTopic {
        title: "Test".into(),
        slug: None,
      })
      .await
      .unwrap();
    assert!(matches!(
      repo.delete_node(&topic.root_node_id).await,
      Err(ForestError::InvalidInput(_))
    ));
    // Root node file should still exist.
    let root_filename = format!("test--{}.md", topic.root_node_id);
    assert!(repo.vault_dir().join("test").join(&root_filename).exists());
  }

  #[tokio::test]
  async fn duplicate_topic_creation_errors() {
    let (_tmp, repo) = fixture().await;
    repo
      .create_topic(NewTopic {
        title: "Same".into(),
        slug: None,
      })
      .await
      .unwrap();
    assert!(matches!(
      repo
        .create_topic(NewTopic {
          title: "Same".into(),
          slug: None,
        })
        .await,
      Err(ForestError::TopicAlreadyExists(_))
    ));
  }

  #[tokio::test]
  async fn external_file_appears_after_cache_rebuild() {
    let (_tmp, repo) = fixture().await;
    let topic = repo
      .create_topic(NewTopic {
        title: "Test".into(),
        slug: None,
      })
      .await
      .unwrap();
    let now = Utc::now();
    let id = NodeId::new();
    let nf = frontmatter::NodeFront {
      id,
      topic: topic.id.clone(),
      parent: Some(topic.root_node_id),
      node_type: NodeType::Concept,
      title: "External".into(),
      links: vec![],
      created_at: now,
      updated_at: now,
      color: None,
    };
    let contents = frontmatter::render_node_file(&nf, "via VS Code").unwrap();
    let path = repo
      .vault_dir()
      .join(topic.id.as_str())
      .join(format!("external--{id}.md"));
    fs::write(&path, contents).await.unwrap();

    let read = repo.read_node(&id).await.unwrap();
    assert_eq!(read.title, "External");
    assert_eq!(read.content, "via VS Code");
  }

  #[tokio::test]
  async fn write_node_renames_file_when_title_changes() {
    let (_tmp, repo) = fixture().await;
    let topic = repo
      .create_topic(NewTopic {
        title: "Test".into(),
        slug: None,
      })
      .await
      .unwrap();
    let now = Utc::now();
    let id = NodeId::new();
    let dir = repo.vault_dir().join(topic.id.as_str());

    repo
      .write_node(&Node {
        id,
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id),
        node_type: NodeType::Concept,
        title: "Backpropagation".into(),
        content: "v1".into(),
        links: vec![],
        created_at: now,
        updated_at: now,
        color: None,
      })
      .await
      .unwrap();
    let original_path = dir.join(format!("backpropagation--{id}.md"));
    assert!(original_path.exists(), "initial file should be at original path");

    // Rename the title — the slug part of the filename should follow.
    repo
      .write_node(&Node {
        id,
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id),
        node_type: NodeType::Concept,
        title: "Backprop".into(),
        content: "v2".into(),
        links: vec![],
        created_at: now,
        updated_at: now,
        color: None,
      })
      .await
      .unwrap();
    let new_path = dir.join(format!("backprop--{id}.md"));
    assert!(new_path.exists(), "file should be at the new slug path");
    assert!(!original_path.exists(), "old slug path should be gone");

    // read_node still works.
    let read = repo.read_node(&id).await.unwrap();
    assert_eq!(read.title, "Backprop");
    assert_eq!(read.content, "v2");
  }

  #[tokio::test]
  async fn write_node_renames_with_unicode_title() {
    let (_tmp, repo) = fixture().await;
    let topic = repo
      .create_topic(NewTopic {
        title: "Test".into(),
        slug: None,
      })
      .await
      .unwrap();
    let now = Utc::now();
    let id = NodeId::new();
    let dir = repo.vault_dir().join(topic.id.as_str());

    repo
      .write_node(&Node {
        id,
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id),
        node_type: NodeType::Concept,
        title: "线性代数".into(),
        content: "".into(),
        links: vec![],
        created_at: now,
        updated_at: now,
        color: None,
      })
      .await
      .unwrap();
    assert!(dir.join(format!("线性代数--{id}.md")).exists());

    repo
      .write_node(&Node {
        id,
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id),
        node_type: NodeType::Concept,
        title: "矩阵".into(),
        content: "".into(),
        links: vec![],
        created_at: now,
        updated_at: now,
        color: None,
      })
      .await
      .unwrap();
    assert!(dir.join(format!("矩阵--{id}.md")).exists());
    assert!(!dir.join(format!("线性代数--{id}.md")).exists());
  }

  #[tokio::test]
  async fn watcher_suppresses_internal_writes_but_not_external() {
    use std::time::Duration;
    use tokio::time::timeout;

    let (_tmp, repo) = fixture().await;
    let topic = repo
      .create_topic(NewTopic {
        title: "Test".into(),
        slug: None,
      })
      .await
      .unwrap();

    let mut handle = repo.watch().expect("watcher start");

    // Drain any leftover events (FSEvents may replay create_topic's writes
    // when watching starts; those should be suppressed since they're
    // registered, but FS history replay can outrun the suppression window
    // in some setups). Wait past one suppression window to settle.
    while let Ok(Some(_)) = timeout(Duration::from_millis(150), handle.events.recv()).await {
    }
    tokio::time::sleep(Duration::from_millis(550)).await;
    while let Ok(Some(_)) = timeout(Duration::from_millis(50), handle.events.recv()).await {
    }

    // Internal write — should NOT generate a watch event.
    let now = Utc::now();
    let id = NodeId::new();
    repo
      .write_node(&Node {
        id,
        topic: topic.id.clone(),
        parent: Some(topic.root_node_id),
        node_type: NodeType::Concept,
        title: "Internal".into(),
        content: "from repo".into(),
        links: vec![],
        created_at: now,
        updated_at: now,
        color: None,
      })
      .await
      .unwrap();

    let internal = timeout(Duration::from_millis(450), handle.events.recv()).await;
    assert!(
      internal.is_err(),
      "internal write should be suppressed; got {internal:?}"
    );

    // External write to the same topic — should fire normally.
    // Wait past the suppression window to ensure no leftover state interferes.
    tokio::time::sleep(Duration::from_millis(550)).await;

    let ext_id = NodeId::new();
    let nf = frontmatter::NodeFront {
      id: ext_id,
      topic: topic.id.clone(),
      parent: Some(topic.root_node_id),
      node_type: NodeType::Concept,
      title: "External".into(),
      links: vec![],
      created_at: now,
      updated_at: now,
      color: None,
    };
    let contents = frontmatter::render_node_file(&nf, "via VS Code").unwrap();
    let ext_path = repo
      .vault_dir()
      .join(topic.id.as_str())
      .join(format!("external--{ext_id}.md"));
    fs::write(&ext_path, contents).await.unwrap();

    let mut saw_external = false;
    while let Ok(Some(ev)) = timeout(Duration::from_secs(2), handle.events.recv()).await {
      if let WatchEvent::Changed(p) = &ev {
        if p.ends_with(format!("external--{ext_id}.md").as_str()) {
          saw_external = true;
          break;
        }
      }
    }
    assert!(saw_external, "external write should fire a watch event");
  }

  #[tokio::test]
  async fn delete_topic_removes_dir_and_caches() {
    let (_tmp, repo) = fixture().await;
    let topic = repo
      .create_topic(NewTopic {
        title: "Doomed".into(),
        slug: None,
      })
      .await
      .unwrap();
    repo.delete_topic(&topic.id).await.unwrap();
    assert!(!repo.vault_dir().join(topic.id.as_str()).exists());
    assert!(matches!(
      repo.get_topic(&topic.id).await,
      Err(ForestError::TopicNotFound(_))
    ));
    // Root node should also be uncached.
    assert!(matches!(
      repo.read_node(&topic.root_node_id).await,
      Err(ForestError::NodeNotFound(_))
    ));
  }
}
