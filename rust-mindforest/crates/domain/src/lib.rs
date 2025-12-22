use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{
  collections::{HashMap, HashSet},
  sync::Arc,
  time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use uuid::Uuid;

pub type TopicId = String;
pub type NodeId = String;
pub type Timestamp = i64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeType {
  Concept,
  Fact,
  Source,
  Example,
  Question,
  Task,
  Misc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMetadata {
  pub node_type: NodeType,
  pub created_at: Timestamp,
  pub updated_at: Timestamp,
  pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeNode {
  pub id: NodeId,
  pub title: String,
  pub content: String,
  pub parent: Option<NodeId>,
  pub children: Vec<NodeId>,
  pub links: Vec<NodeId>,
  pub metadata: NodeMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TreeLayout {
  Binary,
  NAry,
  Pythagorean,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutConfig {
  pub tree_layout: TreeLayout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Topic {
  pub id: TopicId,
  pub title: String,
  pub root_node_id: NodeId,
  pub nodes: HashMap<NodeId, KnowledgeNode>,
  pub bulletin: String,
  pub version: u32,
  pub layout: LayoutConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopicSummary {
  pub id: TopicId,
  pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTopicRequest {
  pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateNodeRequest {
  #[serde(default)]
  pub id: Option<NodeId>,
  pub title: String,
  #[serde(default)]
  pub content: String,
  pub parent: Option<NodeId>,
  pub node_type: Option<NodeType>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateNodeRequest {
  pub title: Option<String>,
  pub content: Option<String>,
  pub links: Option<Vec<NodeId>>,
}

#[derive(Debug, Error)]
pub enum ForestError {
  #[error("topic not found")]
  TopicNotFound,
  #[error("node not found")]
  NodeNotFound,
  #[error("invalid input: {0}")]
  InvalidInput(String),
  #[error("storage error: {0}")]
  Storage(String),
}

pub type ForestResult<T> = Result<T, ForestError>;

#[async_trait]
pub trait ForestRepository: Send + Sync {
  async fn list_topics(&self) -> ForestResult<Vec<TopicSummary>>;
  async fn fetch_topic(&self, id: &TopicId) -> ForestResult<Option<Topic>>;
  async fn save_topic(&self, topic: Topic) -> ForestResult<()>;
}

pub type DynRepository = Arc<dyn ForestRepository>;

#[derive(Clone)]
pub struct ForestService {
  repo: DynRepository,
}

impl ForestService {
  pub fn new<R>(repo: R) -> Self
  where
    R: ForestRepository + 'static,
  {
    Self {
      repo: Arc::new(repo),
    }
  }

  pub async fn list_topics(&self) -> ForestResult<Vec<TopicSummary>> {
    self.repo.list_topics().await
  }

  pub async fn get_topic(&self, id: &TopicId) -> ForestResult<Topic> {
    self.repo
      .fetch_topic(id)
      .await?
      .ok_or(ForestError::TopicNotFound)
  }

  pub async fn create_topic(&self, payload: CreateTopicRequest) -> ForestResult<Topic> {
    if payload.title.trim().is_empty() {
      return Err(ForestError::InvalidInput("title is required".into()));
    }

    let now = now_ms();
    let topic_id = Uuid::new_v4().to_string();
    let root_id = Uuid::new_v4().to_string();

    let root_node = KnowledgeNode {
      id: root_id.clone(),
      title: payload.title.clone(),
      content: String::new(),
      parent: None,
      children: Vec::new(),
      links: Vec::new(),
      metadata: NodeMetadata {
        node_type: NodeType::Concept,
        created_at: now,
        updated_at: now,
        color: None,
      },
    };

    let topic = Topic {
      id: topic_id,
      title: payload.title,
      root_node_id: root_id.clone(),
      nodes: HashMap::from([(root_id, root_node)]),
      bulletin: String::new(),
      version: 1,
      layout: LayoutConfig {
        tree_layout: TreeLayout::Binary,
      },
    };

    self.repo.save_topic(topic.clone()).await?;
    Ok(topic)
  }

  pub async fn add_node(&self, topic_id: &TopicId, payload: CreateNodeRequest) -> ForestResult<Topic> {
    let mut topic = self
      .repo
      .fetch_topic(topic_id)
      .await?
      .ok_or(ForestError::TopicNotFound)?;

    let parent_id = payload
      .parent
      .clone()
      .unwrap_or_else(|| topic.root_node_id.clone());
    let now = now_ms();

    let node_id = payload.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
    if topic.nodes.contains_key(&node_id) {
      return Err(ForestError::InvalidInput("node id already exists".into()));
    }

    let Some(parent_node) = topic.nodes.get_mut(&parent_id) else {
      return Err(ForestError::NodeNotFound);
    };
    let node = KnowledgeNode {
      id: node_id.clone(),
      title: payload.title,
      content: payload.content,
      parent: Some(parent_id.clone()),
      children: Vec::new(),
      links: Vec::new(),
      metadata: NodeMetadata {
        node_type: payload.node_type.unwrap_or(NodeType::Concept),
        created_at: now,
        updated_at: now,
        color: None,
      },
    };

    parent_node.children.push(node_id.clone());
    parent_node.metadata.updated_at = now;
    topic.nodes.insert(node_id, node);
    topic.version += 1;

    self.repo.save_topic(topic.clone()).await?;
    Ok(topic)
  }

  pub async fn update_node(
    &self,
    topic_id: &TopicId,
    node_id: &NodeId,
    payload: UpdateNodeRequest,
  ) -> ForestResult<Topic> {
    let mut topic = self
      .repo
      .fetch_topic(topic_id)
      .await?
      .ok_or(ForestError::TopicNotFound)?;

    let Some(node) = topic.nodes.get_mut(node_id) else {
      return Err(ForestError::NodeNotFound);
    };

    let now = now_ms();
    if let Some(title) = payload.title {
      node.title = title;
    }
    if let Some(content) = payload.content {
      node.content = content;
    }
    if let Some(links) = payload.links {
      node.links = links;
    }
    node.metadata.updated_at = now;
    topic.version += 1;

    self.repo.save_topic(topic.clone()).await?;
    Ok(topic)
  }

  pub async fn delete_node(&self, topic_id: &TopicId, node_id: &NodeId) -> ForestResult<Topic> {
    let mut topic = self
      .repo
      .fetch_topic(topic_id)
      .await?
      .ok_or(ForestError::TopicNotFound)?;

    if node_id == &topic.root_node_id {
      return Err(ForestError::InvalidInput("cannot delete root node".into()));
    }

    if !topic.nodes.contains_key(node_id) {
      return Err(ForestError::NodeNotFound);
    }

    let mut to_remove = HashSet::new();
    collect_descendants(&topic.nodes, node_id, &mut to_remove);

    // Remove references from parents
    let parent_id = topic
      .nodes
      .get(node_id)
      .and_then(|node| node.parent.clone());

    if let Some(parent_id) = parent_id {
      if let Some(parent) = topic.nodes.get_mut(&parent_id) {
        parent.children.retain(|child_id| !to_remove.contains(child_id));
        parent.metadata.updated_at = now_ms();
      }
    }

    // Remove links pointing to deleted nodes
    for node in topic.nodes.values_mut() {
      node.links.retain(|link| !to_remove.contains(link));
    }

    // Delete nodes
    for id in to_remove {
      topic.nodes.remove(&id);
    }

    topic.version += 1;
    self.repo.save_topic(topic.clone()).await?;
    Ok(topic)
  }
}

fn collect_descendants(nodes: &HashMap<NodeId, KnowledgeNode>, start: &NodeId, acc: &mut HashSet<NodeId>) {
  if acc.contains(start) {
    return;
  }

  acc.insert(start.clone());
  if let Some(node) = nodes.get(start) {
    for child_id in &node.children {
      collect_descendants(nodes, child_id, acc);
    }
  }
}

fn now_ms() -> Timestamp {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as Timestamp)
    .unwrap_or(0)
}
