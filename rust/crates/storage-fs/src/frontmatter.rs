//! YAML frontmatter sandwich helpers.
//!
//! Format:
//! ```text
//! ---
//! key: value
//! ...
//! ---
//!
//! markdown body
//! ```
//!
//! We always write a deterministic shape (one trailing newline after `---`,
//! one blank line, body, trailing newline) so files diff cleanly.

use serde::{Deserialize, Serialize};

use domain::{ForestError, ForestResult, NodeId, NodeType, Timestamp, TopicId};

const FRONT_OPEN: &str = "---\n";
const FRONT_CLOSE: &str = "\n---";

/// Frontmatter shape for a regular node file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct NodeFront {
  pub id: NodeId,
  pub topic: TopicId,
  #[serde(default)]
  pub parent: Option<NodeId>,
  #[serde(default, rename = "type")]
  pub node_type: NodeType,
  pub title: String,
  #[serde(default)]
  pub links: Vec<NodeId>,
  pub created_at: Timestamp,
  pub updated_at: Timestamp,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub color: Option<String>,
}

/// Frontmatter shape for `_topic.md` — the topic root node plus
/// topic-level fields (`bulletin`, `is_topic_root` discriminator).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct TopicFront {
  pub id: NodeId,
  pub topic: TopicId,
  #[serde(default)]
  pub parent: Option<NodeId>,
  #[serde(default, rename = "type")]
  pub node_type: NodeType,
  pub title: String,
  #[serde(default)]
  pub links: Vec<NodeId>,
  pub created_at: Timestamp,
  pub updated_at: Timestamp,
  #[serde(default, skip_serializing_if = "String::is_empty")]
  pub bulletin: String,
  #[serde(default)]
  pub is_topic_root: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub color: Option<String>,
}

/// Split a markdown file into (yaml_str, body_str). Body has its leading
/// blank line stripped but keeps trailing content as-is.
pub(crate) fn split_frontmatter(text: &str) -> ForestResult<(&str, &str)> {
  let after_open = text
    .strip_prefix(FRONT_OPEN)
    .ok_or_else(|| ForestError::Storage("file missing leading `---` frontmatter".into()))?;
  let close_idx = after_open
    .find(FRONT_CLOSE)
    .ok_or_else(|| ForestError::Storage("frontmatter not closed by `---`".into()))?;
  let yaml = &after_open[..close_idx];
  let after_close = &after_open[close_idx + FRONT_CLOSE.len()..];
  let body = after_close.trim_start_matches('\n');
  Ok((yaml, body))
}

pub(crate) fn render_node_file(front: &NodeFront, body: &str) -> ForestResult<String> {
  let yaml = serde_yml::to_string(front)
    .map_err(|e| ForestError::Storage(format!("yaml serialize: {e}")))?;
  Ok(sandwich(&yaml, body))
}

pub(crate) fn render_topic_file(front: &TopicFront, body: &str) -> ForestResult<String> {
  let yaml = serde_yml::to_string(front)
    .map_err(|e| ForestError::Storage(format!("yaml serialize: {e}")))?;
  Ok(sandwich(&yaml, body))
}

fn sandwich(yaml: &str, body: &str) -> String {
  let trimmed_body = body.trim_end_matches('\n');
  if trimmed_body.is_empty() {
    format!("---\n{yaml}---\n")
  } else {
    format!("---\n{yaml}---\n\n{trimmed_body}\n")
  }
}

pub(crate) fn parse_node_front(yaml: &str) -> ForestResult<NodeFront> {
  serde_yml::from_str(yaml).map_err(|e| ForestError::Storage(format!("parse node frontmatter: {e}")))
}

pub(crate) fn parse_topic_front(yaml: &str) -> ForestResult<TopicFront> {
  serde_yml::from_str(yaml)
    .map_err(|e| ForestError::Storage(format!("parse topic frontmatter: {e}")))
}

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::Utc;

  #[test]
  fn split_frontmatter_basic() {
    let text = "---\nkey: value\n---\n\nbody text\n";
    let (yaml, body) = split_frontmatter(text).unwrap();
    assert_eq!(yaml, "key: value");
    assert_eq!(body, "body text\n");
  }

  #[test]
  fn split_frontmatter_empty_body() {
    let text = "---\nkey: value\n---\n";
    let (_, body) = split_frontmatter(text).unwrap();
    assert_eq!(body, "");
  }

  #[test]
  fn split_frontmatter_no_open_errors() {
    assert!(split_frontmatter("not a frontmatter file").is_err());
  }

  #[test]
  fn split_frontmatter_no_close_errors() {
    assert!(split_frontmatter("---\nkey: value\n").is_err());
  }

  #[test]
  fn node_file_roundtrip() {
    let now = Utc::now();
    let topic = TopicId::new("test").unwrap();
    let front = NodeFront {
      id: NodeId::new(),
      topic: topic.clone(),
      parent: None,
      node_type: NodeType::Concept,
      title: "Hello".into(),
      links: vec![],
      created_at: now,
      updated_at: now,
      color: None,
    };
    let rendered = render_node_file(&front, "Some markdown body").unwrap();
    assert!(rendered.starts_with("---\n"));
    assert!(rendered.contains("Some markdown body"));
    let (yaml, body) = split_frontmatter(&rendered).unwrap();
    let parsed = parse_node_front(yaml).unwrap();
    assert_eq!(parsed.title, "Hello");
    assert_eq!(parsed.id, front.id);
    assert_eq!(body.trim_end(), "Some markdown body");
  }
}
