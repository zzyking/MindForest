//! `storage-fs` — markdown source-of-truth backend for MindForest.
//!
//! Layout:
//!
//! ```text
//! vault/
//! ├─ deep-learning/
//! │  ├─ _topic.md                       topic root + metadata + bulletin
//! │  ├─ backprop--01HV6Q...md           regular node
//! │  └─ chain-rule--01HV6R...md
//! └─ linear-algebra/
//!    └─ ...
//! ```
//!
//! Files are the authoritative state; an in-memory `id → (topic, path)`
//! cache speeds up lookups and is rebuilt lazily on miss. The watcher
//! actor (separate commit) keeps the cache fresh against external edits.

mod frontmatter;
mod paths;
mod watcher;

pub use watcher::{watch_vault, WatchEvent, WatcherHandle};

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
  cache: RwLock<HashMap<NodeId, NodeLocation>>,
}

#[derive(Debug, Clone)]
struct NodeLocation {
  topic: TopicId,
  path: PathBuf,
}

impl FsRepository {
  /// Open (creating if missing) a vault at `vault`. The directory is
  /// created with `create_dir_all`; existing contents are preserved.
  pub async fn open(vault: impl Into<PathBuf>) -> ForestResult<Self> {
    let vault: PathBuf = vault.into();
    fs::create_dir_all(&vault)
      .await
      .map_err(|e| ForestError::Storage(format!("create vault {vault:?}: {e}")))?;
    Ok(Self {
      inner: Arc::new(Inner {
        vault,
        cache: RwLock::new(HashMap::new()),
      }),
    })
  }

  pub fn vault_dir(&self) -> &Path {
    &self.inner.vault
  }

  /// Begin watching the vault for filesystem changes. Returns a handle
  /// whose `events` receiver yields `WatchEvent`s; dropping the handle
  /// stops the watcher. Consumers should re-read affected files via
  /// `read_node` and dedupe via content-hash before re-indexing.
  pub fn watch(&self) -> ForestResult<WatcherHandle> {
    watch_vault(&self.inner.vault)
  }

  /// Walk all topics, repopulating the in-memory location cache from disk.
  /// Idempotent. Used on cache miss; the watcher will call this on directory
  /// shape changes too.
  pub async fn rebuild_cache(&self) -> ForestResult<()> {
    let mut new_cache: HashMap<NodeId, NodeLocation> = HashMap::new();
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
      scan_topic_dir(&topic, &path, &mut new_cache).await;
    }
    let mut cache = self.inner.cache.write().await;
    *cache = new_cache;
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
}

async fn scan_topic_dir(topic: &TopicId, topic_path: &Path, out: &mut HashMap<NodeId, NodeLocation>) {
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
    let id = if name == TOPIC_FILE {
      match read_topic_file_id(&path).await {
        Ok(id) => id,
        Err(e) => {
          tracing::warn!("malformed {path:?}: {e}");
          continue;
        }
      }
    } else if let Some(id) = id_from_filename(name) {
      id
    } else {
      continue;
    };
    out.insert(
      id,
      NodeLocation {
        topic: topic.clone(),
        path,
      },
    );
  }
}

async fn read_topic_file_id(path: &Path) -> ForestResult<NodeId> {
  let text = fs::read_to_string(path)
    .await
    .map_err(|e| ForestError::Storage(format!("read {path:?}: {e}")))?;
  let (yaml, _) = frontmatter::split_frontmatter(&text)?;
  Ok(parse_topic_front(yaml)?.id)
}

async fn read_node_file(path: &Path) -> ForestResult<(NodeFront, String)> {
  let text = fs::read_to_string(path)
    .await
    .map_err(|e| ForestError::Storage(format!("read {path:?}: {e}")))?;
  let (yaml, body) = frontmatter::split_frontmatter(&text)?;
  let front = parse_node_front(yaml)?;
  Ok((front, body.trim_end_matches('\n').to_string()))
}

async fn read_topic_file_full(path: &Path) -> ForestResult<(TopicFront, String)> {
  let text = fs::read_to_string(path)
    .await
    .map_err(|e| ForestError::Storage(format!("read {path:?}: {e}")))?;
  let (yaml, body) = frontmatter::split_frontmatter(&text)?;
  let front = parse_topic_front(yaml)?;
  Ok((front, body.trim_end_matches('\n').to_string()))
}

/// Atomic write: tempfile in same dir + fsync + rename. Crash at any
/// point leaves the previous file intact.
async fn atomic_write(path: &Path, contents: &str) -> ForestResult<()> {
  let path = path.to_path_buf();
  let contents = contents.to_owned();
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
      let (front, _) = match read_topic_file_full(&topic_path).await {
        Ok(x) => x,
        Err(_) => continue, // dir without _topic.md isn't a topic
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
    let (front, _) = read_topic_file_full(&path).await.map_err(|e| match e {
      ForestError::Storage(msg) if msg.contains("No such file") => {
        ForestError::TopicNotFound(id.clone())
      }
      other => other,
    })?;
    Ok(Topic {
      id: id.clone(),
      title: front.title,
      root_node_id: front.id,
      bulletin: front.bulletin,
      created_at: front.created_at,
      updated_at: front.updated_at,
    })
  }

  async fn create_topic(&self, new_topic: NewTopic) -> ForestResult<Topic> {
    let title = new_topic.title.trim().to_string();
    if title.is_empty() {
      return Err(ForestError::InvalidInput("topic title must not be empty".into()));
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
    let front = TopicFront {
      id: root_id,
      topic: id.clone(),
      parent: None,
      node_type: NodeType::Concept,
      title: title.clone(),
      links: vec![],
      created_at: now,
      updated_at: now,
      bulletin: String::new(),
      is_topic_root: true,
      color: None,
    };
    let path = topic_file(&self.inner.vault, &id);
    let contents = frontmatter::render_topic_file(&front, "")?;
    atomic_write(&path, &contents).await?;
    self.inner.cache.write().await.insert(
      root_id,
      NodeLocation {
        topic: id.clone(),
        path,
      },
    );
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
    self.inner.cache.write().await.retain(|_, loc| loc.topic != *id);
    Ok(())
  }

  async fn read_node(&self, id: &NodeId) -> ForestResult<Node> {
    let loc = self.locate(id).await?;
    let is_root = loc
      .path
      .file_name()
      .map(|n| n == TOPIC_FILE)
      .unwrap_or(false);
    if is_root {
      let (front, body) = read_topic_file_full(&loc.path).await?;
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
    } else {
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
  }

  async fn write_node(&self, node: &Node) -> ForestResult<()> {
    let existing = self.inner.cache.read().await.get(&node.id).cloned();
    let path = match existing {
      Some(loc) => loc.path,
      None => {
        // New regular node — _topic.md is created via create_topic only.
        let dir = topic_dir(&self.inner.vault, &node.topic);
        if !dir.exists() {
          return Err(ForestError::TopicNotFound(node.topic.clone()));
        }
        dir.join(new_node_filename(&node.title, &node.id))
      }
    };
    let is_root = path.file_name().map(|n| n == TOPIC_FILE).unwrap_or(false);
    if is_root {
      // Preserve `bulletin` and `is_topic_root` flag — Node doesn't carry them.
      let (mut tf, _) = read_topic_file_full(&path).await?;
      tf.title = node.title.clone();
      tf.node_type = node.node_type;
      tf.links = node.links.clone();
      tf.parent = node.parent;
      tf.updated_at = node.updated_at;
      tf.color = node.color.clone();
      let contents = frontmatter::render_topic_file(&tf, &node.content)?;
      atomic_write(&path, &contents).await?;
    } else {
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
      let contents = frontmatter::render_node_file(&nf, &node.content)?;
      atomic_write(&path, &contents).await?;
    }
    self.inner.cache.write().await.insert(
      node.id,
      NodeLocation {
        topic: node.topic.clone(),
        path,
      },
    );
    Ok(())
  }

  async fn delete_node(&self, id: &NodeId) -> ForestResult<()> {
    let loc = self.locate(id).await?;
    if loc.path.file_name().map(|n| n == TOPIC_FILE).unwrap_or(false) {
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
      if !name.ends_with(".md") {
        continue;
      }
      let node_result = if name == TOPIC_FILE {
        read_topic_file_full(&path).await.map(|(front, body)| Node {
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
        })
      } else {
        read_node_file(&path).await.map(|(front, body)| Node {
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
        })
      };
      match node_result {
        Ok(node) => nodes.push(node),
        Err(e) => tracing::warn!("skipping {path:?}: {e}"),
      }
    }
    Ok(nodes)
  }
}

async fn count_node_files(dir: &Path) -> usize {
  let Ok(mut files) = fs::read_dir(dir).await else { return 0 };
  let mut count = 0usize;
  while let Ok(Some(entry)) = files.next_entry().await {
    let name = entry.file_name();
    let s = name.to_string_lossy();
    if s.ends_with(".md") {
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
  async fn create_topic_writes_files_and_returns_topic() {
    let (_tmp, repo) = fixture().await;
    let topic = repo
      .create_topic(NewTopic {
        title: "Deep Learning".into(),
        slug: None,
      })
      .await
      .unwrap();

    assert_eq!(topic.id.as_str(), "deep-learning");
    assert_eq!(topic.title, "Deep Learning");
    assert!(repo.vault_dir().join("deep-learning").join("_topic.md").exists());

    let listed = repo.list_topics().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].title, "Deep Learning");
    assert_eq!(listed[0].node_count, 1); // root counts
  }

  #[tokio::test]
  async fn get_topic_recovers_round_trip() {
    let (_tmp, repo) = fixture().await;
    let created = repo
      .create_topic(NewTopic {
        title: "Linear Algebra".into(),
        slug: None,
      })
      .await
      .unwrap();
    let fetched = repo.get_topic(&created.id).await.unwrap();
    assert_eq!(fetched.title, "Linear Algebra");
    assert_eq!(fetched.root_node_id, created.root_node_id);
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
    assert_eq!(nodes.len(), 4); // root + A + B + C
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
  async fn delete_node_refuses_topic_root() {
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
    // Simulate external write: drop a manually-crafted .md file in the topic dir.
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
  async fn delete_topic_removes_dir_and_cache() {
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
  }
}
