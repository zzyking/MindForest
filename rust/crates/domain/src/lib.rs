//! MindForest domain types and traits.
//!
//! Pure data + trait definitions. No tokio runtime, no I/O. Concrete
//! implementations live in `storage-fs` (markdown source-of-truth),
//! `index-sqlite` (FTS + vec index), `embed` (Swift sidecar client),
//! and `agent` (Claude proxy).

use std::fmt;
use std::str::FromStr;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;
use ulid::Ulid;

// ─────────────────────────────────────────────────────────────────────
// IDs
// ─────────────────────────────────────────────────────────────────────

/// Stable, sortable, immutable per-node identifier (ULID, 26 chars).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeId(pub Ulid);

impl NodeId {
  pub fn new() -> Self {
    Self(Ulid::new())
  }
}

impl Default for NodeId {
  fn default() -> Self {
    Self::new()
  }
}

impl fmt::Display for NodeId {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{}", self.0)
  }
}

impl FromStr for NodeId {
  type Err = ForestError;
  fn from_str(s: &str) -> ForestResult<Self> {
    Ulid::from_string(s)
      .map(Self)
      .map_err(|_| ForestError::InvalidInput(format!("invalid NodeId: {s:?}")))
  }
}

/// Slug-based topic identifier. Doubles as the topic's directory name
/// under `vault/`. Constraint: 1–64 chars, ASCII lowercase + digits + `-`.
///
/// `Deserialize` is implemented manually so the constraint runs on every
/// inbound payload (HTTP, file frontmatter). A derived `transparent`
/// deserializer would silently accept invalid slugs.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct TopicId(String);

impl TopicId {
  pub fn new(slug: impl Into<String>) -> ForestResult<Self> {
    let s = slug.into();
    if s.is_empty() || s.len() > 64 {
      return Err(ForestError::InvalidInput(
        "topic slug must be 1–64 chars".into(),
      ));
    }
    if !s
      .chars()
      .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
      return Err(ForestError::InvalidInput(
        "topic slug must be ASCII lowercase, digits, or '-'".into(),
      ));
    }
    if s.starts_with('-') || s.ends_with('-') {
      return Err(ForestError::InvalidInput(
        "topic slug must not start or end with '-'".into(),
      ));
    }
    Ok(Self(s))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }
}

impl fmt::Display for TopicId {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{}", self.0)
  }
}

impl AsRef<str> for TopicId {
  fn as_ref(&self) -> &str {
    &self.0
  }
}

impl<'de> Deserialize<'de> for TopicId {
  fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
    let s = String::deserialize(d)?;
    Self::new(s).map_err(serde::de::Error::custom)
  }
}

// ─────────────────────────────────────────────────────────────────────
// Node + Topic data
// ─────────────────────────────────────────────────────────────────────

pub type Timestamp = DateTime<Utc>;

/// Epistemic role of a node. Variants are additive-only: the wire value
/// is persisted in every node file's frontmatter and serde rejects
/// unknown enum strings (`#[serde(default)]` only covers a *missing*
/// field) — removing or renaming a variant would make existing vaults
/// fail to parse. Add new roles at the position that reads best in
/// pickers; order here is mirrored by the UI's display order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum NodeType {
  #[default]
  Concept,
  Idea,
  Fact,
  Source,
  Example,
  Question,
  Task,
  Misc,
}

/// A single node in a topic's tree, also potentially graph-linked across topics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
  pub id: NodeId,
  pub topic: TopicId,
  pub parent: Option<NodeId>,
  #[serde(rename = "type", default)]
  pub node_type: NodeType,
  pub title: String,
  #[serde(default)]
  pub content: String,
  #[serde(default)]
  pub links: Vec<NodeId>,
  pub created_at: Timestamp,
  pub updated_at: Timestamp,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub color: Option<String>,
}

/// Partial update — only fields set to `Some(_)` are touched. `links: Some(vec![])`
/// clears links; `links: None` leaves them unchanged. `parent` cannot be cleared
/// via patch (the topic root's parent stays None implicitly; non-root nodes always
/// have a parent — drag-to-reparent only ever moves them under a different node).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NodePatch {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub content: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub links: Option<Vec<NodeId>>,
  #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
  pub node_type: Option<NodeType>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub parent: Option<NodeId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewNode {
  pub topic: TopicId,
  pub parent: Option<NodeId>,
  pub title: String,
  #[serde(default)]
  pub content: String,
  #[serde(default)]
  pub node_type: NodeType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Topic {
  pub id: TopicId,
  pub title: String,
  pub root_node_id: NodeId,
  #[serde(default)]
  pub bulletin: String,
  pub created_at: Timestamp,
  pub updated_at: Timestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopicSummary {
  pub id: TopicId,
  pub title: String,
  pub node_count: usize,
  pub updated_at: Timestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewTopic {
  pub title: String,
  /// If omitted, derived from `title`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub slug: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum ForestError {
  #[error("topic not found: {0}")]
  TopicNotFound(TopicId),

  #[error("node not found: {0}")]
  NodeNotFound(NodeId),

  #[error("topic already exists: {0}")]
  TopicAlreadyExists(TopicId),

  #[error("invalid input: {0}")]
  InvalidInput(String),

  #[error("storage error: {0}")]
  Storage(String),

  #[error("index error: {0}")]
  Index(String),

  #[error("embedding unavailable on this platform")]
  EmbedUnavailable,

  #[error("embedding error: {0}")]
  Embed(String),

  #[error("agent error: {0}")]
  Agent(String),
}

pub type ForestResult<T> = Result<T, ForestError>;

// ─────────────────────────────────────────────────────────────────────
// Search / index status
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
  pub id: NodeId,
  pub topic: TopicId,
  pub title: String,
  pub snippet: String,
  pub score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexStatus {
  pub embed_pending: usize,
  pub fts_dirty: bool,
  pub last_scan: Option<Timestamp>,
  pub embed_available: bool,
}

// ─────────────────────────────────────────────────────────────────────
// ForestRepository — file-backed source of truth (storage-fs)
// ─────────────────────────────────────────────────────────────────────

/// Authoritative read/write for nodes + topic metadata. Backed by
/// markdown files with YAML frontmatter under `vault/`.
#[async_trait]
pub trait ForestRepository: Send + Sync {
  async fn list_topics(&self) -> ForestResult<Vec<TopicSummary>>;
  async fn get_topic(&self, id: &TopicId) -> ForestResult<Topic>;
  async fn create_topic(&self, new_topic: NewTopic) -> ForestResult<Topic>;
  async fn delete_topic(&self, id: &TopicId) -> ForestResult<()>;

  async fn read_node(&self, id: &NodeId) -> ForestResult<Node>;
  async fn write_node(&self, node: &Node) -> ForestResult<()>;
  async fn delete_node(&self, id: &NodeId) -> ForestResult<()>;
  async fn list_nodes_in_topic(&self, topic: &TopicId) -> ForestResult<Vec<Node>>;
}

// ─────────────────────────────────────────────────────────────────────
// Indexer — derived FTS + vector index (index-sqlite)
// ─────────────────────────────────────────────────────────────────────

/// A pending embedding job — one per node whose content (title or body)
/// changed since its last embedding was stored. The worker (`app-core`)
/// reads these, calls the `Embedder`, and writes the resulting vector
/// back via `upsert_embedding`.
#[derive(Debug, Clone)]
pub struct EmbedJob {
  pub id: NodeId,
  pub content_hash: String,
}

/// Search and indexing operations. Fully rebuildable from a `ForestRepository`.
#[async_trait]
pub trait Indexer: Send + Sync {
  async fn upsert(&self, node: &Node) -> ForestResult<()>;
  async fn delete(&self, id: &NodeId) -> ForestResult<()>;

  async fn search_fts(
    &self,
    query: &str,
    topic: Option<&TopicId>,
    k: usize,
  ) -> ForestResult<Vec<SearchHit>>;

  async fn search_vec(
    &self,
    embedding: &[f32],
    topic: Option<&TopicId>,
    k: usize,
  ) -> ForestResult<Vec<SearchHit>>;

  async fn status(&self) -> ForestResult<IndexStatus>;

  async fn rebuild_from(&self, repo: &dyn ForestRepository) -> ForestResult<()>;

  /// Install (or replace) a pre-computed embedding. The `content_hash`
  /// must match the one in the corresponding `embed_jobs` row — if it
  /// doesn't, the node has changed since enqueue and the worker should
  /// drop this result rather than mark the job done.
  async fn upsert_embedding(
    &self,
    id: &NodeId,
    content_hash: &str,
    embedding: &[f32],
  ) -> ForestResult<()>;

  /// Mark an embed job errored (so the worker doesn't immediately retry).
  /// A subsequent content change re-enqueues the node automatically.
  async fn mark_embed_error(&self, id: &NodeId, message: &str) -> ForestResult<()>;

  /// Fetch up to `limit` pending embedding jobs.
  async fn pending_embed_jobs(&self, limit: usize) -> ForestResult<Vec<EmbedJob>>;
}

// ─────────────────────────────────────────────────────────────────────
// Embedder — local MLX sidecar (embed crate)
// ─────────────────────────────────────────────────────────────────────

/// Text → fixed-dimension float vector. Returns `EmbedUnavailable` when
/// the platform/sidecar isn't usable; callers should degrade to FTS-only.
#[async_trait]
pub trait Embedder: Send + Sync {
  /// Embed a batch of texts. Returns one f32 vector per input,
  /// each of length `self.dim()`.
  async fn embed(&self, texts: &[String]) -> ForestResult<Vec<Vec<f32>>>;

  /// Output dimension (e.g. 768 for EmbeddingGemma 300M).
  fn dim(&self) -> usize;

  /// Whether the underlying sidecar is healthy and the model is loaded.
  fn available(&self) -> bool;
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn topic_id_validates_slug() {
    assert!(TopicId::new("deep-learning").is_ok());
    assert!(TopicId::new("hello123").is_ok());
    assert!(TopicId::new("a").is_ok());

    assert!(TopicId::new("").is_err());
    assert!(TopicId::new("Has-Caps").is_err());
    assert!(TopicId::new("has spaces").is_err());
    assert!(TopicId::new("中文").is_err());
    assert!(TopicId::new("x".repeat(65)).is_err());
    assert!(TopicId::new("-leading").is_err());
    assert!(TopicId::new("trailing-").is_err());
  }

  #[test]
  fn node_id_string_roundtrip() {
    let id = NodeId::new();
    let s = id.to_string();
    let parsed: NodeId = s.parse().expect("ulid should parse");
    assert_eq!(id, parsed);
    assert_eq!(s.len(), 26);
  }

  #[test]
  fn node_id_invalid_string_errors() {
    let result: ForestResult<NodeId> = "not-a-ulid".parse();
    assert!(matches!(result, Err(ForestError::InvalidInput(_))));
  }

  #[test]
  fn node_type_serializes_lowercase() {
    assert_eq!(serde_json::to_string(&NodeType::Concept).unwrap(), "\"concept\"");
    assert_eq!(serde_json::to_string(&NodeType::Misc).unwrap(), "\"misc\"");

    let parsed: NodeType = serde_json::from_str("\"fact\"").unwrap();
    assert_eq!(parsed, NodeType::Fact);
  }

  #[test]
  fn node_serializes_type_field_not_node_type() {
    let now = Utc::now();
    let node = Node {
      id: NodeId::new(),
      topic: TopicId::new("test").unwrap(),
      parent: None,
      node_type: NodeType::Concept,
      title: "Backprop".into(),
      content: "Body".into(),
      links: vec![],
      created_at: now,
      updated_at: now,
      color: None,
    };
    let json = serde_json::to_value(&node).unwrap();
    assert_eq!(json["type"], "concept");
    assert!(!json.as_object().unwrap().contains_key("node_type"));
    assert!(!json.as_object().unwrap().contains_key("color"));
  }

  #[test]
  fn node_patch_omits_unset_fields() {
    let patch = NodePatch {
      title: Some("New Title".into()),
      ..Default::default()
    };
    let json = serde_json::to_value(&patch).unwrap();
    assert_eq!(json["title"], "New Title");
    let obj = json.as_object().unwrap();
    assert_eq!(obj.len(), 1);
  }

  #[test]
  fn node_patch_with_explicit_empty_links() {
    let patch = NodePatch {
      links: Some(vec![]),
      ..Default::default()
    };
    let json = serde_json::to_value(&patch).unwrap();
    assert!(json["links"].is_array());
    assert_eq!(json["links"].as_array().unwrap().len(), 0);
  }

  #[test]
  fn forest_error_display_includes_id() {
    let id = TopicId::new("missing").unwrap();
    let err = ForestError::TopicNotFound(id);
    assert!(err.to_string().contains("missing"));
  }
}
