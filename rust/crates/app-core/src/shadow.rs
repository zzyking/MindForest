//! H3 shadow vault — journaling overlay over `ForestService`.
//!
//! Write tools during `propose` land here, not on disk. Reads see the
//! overlay first (so a create in this turn is visible to a later
//! `mf_read_node` / `mf_create_node` parent), then fall through to the
//! real vault. Accept replays the journal onto `ForestService` in order;
//! reject drops the entry.

use std::collections::HashMap;
use std::sync::Arc;

use agent::{
  parse_node_type, AgentToolCall, StagedOp, ToolExecutor, ToolResult, DEFAULT_SEARCH_K,
};
use async_trait::async_trait;
use chrono::Utc;
use domain::{Node, NodeId, NodePatch, NodeType};
use tokio::sync::Mutex;

use crate::ForestService;

const MAX_SEARCH_K: usize = 25;

/// In-memory journaling overlay for one agent turn.
pub struct ShadowForest {
  base: Arc<ForestService>,
  /// Nodes created or last-written by this turn, keyed by id.
  overlay: Mutex<HashMap<NodeId, Node>>,
  /// Ordered mutations for accept + staged-diff UI.
  journal: Mutex<Vec<StagedOp>>,
}

impl ShadowForest {
  pub fn new(base: Arc<ForestService>) -> Self {
    Self {
      base,
      overlay: Mutex::new(HashMap::new()),
      journal: Mutex::new(Vec::new()),
    }
  }

  pub async fn journal_snapshot(&self) -> Vec<StagedOp> {
    self.journal.lock().await.clone()
  }

  /// Read: overlay hit, else real vault.
  async fn get_node(&self, id: &NodeId) -> Result<Node, String> {
    if let Some(n) = self.overlay.lock().await.get(id).cloned() {
      return Ok(n);
    }
    self
      .base
      .get_node(id)
      .await
      .map_err(|e| format!("could not read node {id}: {e}"))
  }

  async fn put_overlay(&self, node: Node) {
    self.overlay.lock().await.insert(node.id, node);
  }

  async fn push_op(&self, op: StagedOp) {
    self.journal.lock().await.push(op);
  }

  async fn create_node(
    &self,
    parent_id: NodeId,
    title: String,
    node_type: NodeType,
    content: String,
  ) -> Result<(Node, StagedOp), String> {
    let parent = self.get_node(&parent_id).await?;
    let now = Utc::now();
    let node = Node {
      id: NodeId::new(),
      topic: parent.topic.clone(),
      parent: Some(parent_id),
      node_type,
      title,
      content,
      links: vec![],
      created_at: now,
      updated_at: now,
      color: None,
    };
    let op = StagedOp::CreateNode { node: node.clone() };
    self.put_overlay(node.clone()).await;
    self.push_op(op.clone()).await;
    Ok((node, op))
  }

  async fn patch_node(
    &self,
    id: NodeId,
    title: Option<String>,
    content: Option<String>,
    node_type: Option<NodeType>,
  ) -> Result<(Node, StagedOp), String> {
    if title.is_none() && content.is_none() && node_type.is_none() {
      return Err("mf_patch_node requires at least one of title, content, type".into());
    }
    let before = self.get_node(&id).await?;
    let mut after = before.clone();
    if let Some(t) = title {
      after.title = t;
    }
    if let Some(c) = content {
      after.content = c;
    }
    if let Some(ty) = node_type {
      after.node_type = ty;
    }
    after.updated_at = Utc::now();
    let op = StagedOp::PatchNode {
      before: before.clone(),
      after: after.clone(),
    };
    self.put_overlay(after.clone()).await;
    self.push_op(op.clone()).await;
    Ok((after, op))
  }

  async fn link_nodes(&self, src_id: NodeId, dst_id: NodeId) -> Result<(Node, StagedOp), String> {
    // Ensure dst exists (overlay or real).
    let _dst = self.get_node(&dst_id).await?;
    let mut after = self.get_node(&src_id).await?;
    if !after.links.contains(&dst_id) {
      after.links.push(dst_id);
      after.updated_at = Utc::now();
    }
    let op = StagedOp::LinkNodes {
      src_id,
      dst_id,
      after: after.clone(),
    };
    self.put_overlay(after.clone()).await;
    self.push_op(op.clone()).await;
    Ok((after, op))
  }

  async fn move_subtree(
    &self,
    id: NodeId,
    new_parent_id: NodeId,
  ) -> Result<(Node, StagedOp), String> {
    let before = self.get_node(&id).await?;
    // Validate against overlay-aware reads (cycle / topic / root).
    self
      .validate_reparent(&before, &new_parent_id)
      .await
      .map_err(|e| e.to_string())?;
    let mut after = before.clone();
    after.parent = Some(new_parent_id);
    after.updated_at = Utc::now();
    let op = StagedOp::MoveSubtree {
      before: before.clone(),
      after: after.clone(),
    };
    self.put_overlay(after.clone()).await;
    self.push_op(op.clone()).await;
    Ok((after, op))
  }

  async fn validate_reparent(&self, node: &Node, new_parent: &NodeId) -> Result<(), String> {
    let topic = self
      .base
      .get_topic(&node.topic)
      .await
      .map_err(|e| e.to_string())?;
    if node.id == topic.root_node_id {
      return Err("cannot reparent the topic root".into());
    }
    if &node.id == new_parent {
      return Err("cannot reparent a node onto itself".into());
    }
    let parent_node = self.get_node(new_parent).await?;
    if parent_node.topic != node.topic {
      return Err("cross-topic reparent is not supported".into());
    }
    let mut cursor = parent_node.parent;
    while let Some(p) = cursor {
      if p == node.id {
        return Err("cannot reparent a node under one of its own descendants".into());
      }
      cursor = self.get_node(&p).await?.parent;
    }
    Ok(())
  }
}

#[async_trait]
impl ToolExecutor for ShadowForest {
  async fn execute(&self, call: AgentToolCall) -> ToolResult {
    match call {
      AgentToolCall::ReadNode(input) => {
        let Ok(id) = input.id.parse::<NodeId>() else {
          return ToolResult::error(format!("not a valid node id: {:?}", input.id));
        };
        match self.get_node(&id).await {
          Ok(node) => match serde_json::to_string(&node) {
            Ok(json) => ToolResult::ok(json),
            Err(e) => ToolResult::error(format!("could not serialize node {id}: {e}")),
          },
          Err(e) => ToolResult::error(e),
        }
      }
      AgentToolCall::Search(input) => {
        // Search still hits the real index (overlay creates aren't indexed
        // until accept). Documented tradeoff for H3 v1.
        let k = input.k.unwrap_or(DEFAULT_SEARCH_K).clamp(1, MAX_SEARCH_K);
        match self.base.search(&input.query, None, k).await {
          Ok(hits) => match serde_json::to_string(&hits) {
            Ok(json) => ToolResult::ok(json),
            Err(e) => ToolResult::error(format!("could not serialize search hits: {e}")),
          },
          Err(e) => ToolResult::error(format!("search failed: {e}")),
        }
      }
      AgentToolCall::CreateNode(input) => {
        let Ok(parent_id) = input.parent_id.parse::<NodeId>() else {
          return ToolResult::error(format!("not a valid parent_id: {:?}", input.parent_id));
        };
        let node_type = match parse_node_type(input.node_type.as_deref()) {
          Ok(t) => t,
          Err(e) => return ToolResult::error(e),
        };
        match self
          .create_node(
            parent_id,
            input.title,
            node_type,
            input.content.unwrap_or_default(),
          )
          .await
        {
          Ok((node, op)) => match serde_json::to_string(&node) {
            Ok(json) => ToolResult::ok_staged(json, op),
            Err(e) => ToolResult::error(format!("serialize: {e}")),
          },
          Err(e) => ToolResult::error(e),
        }
      }
      AgentToolCall::PatchNode(input) => {
        let Ok(id) = input.id.parse::<NodeId>() else {
          return ToolResult::error(format!("not a valid node id: {:?}", input.id));
        };
        let node_type = match input.node_type.as_deref() {
          None => None,
          Some(s) => match parse_node_type(Some(s)) {
            Ok(t) => Some(t),
            Err(e) => return ToolResult::error(e),
          },
        };
        match self
          .patch_node(id, input.title, input.content, node_type)
          .await
        {
          Ok((node, op)) => match serde_json::to_string(&node) {
            Ok(json) => ToolResult::ok_staged(json, op),
            Err(e) => ToolResult::error(format!("serialize: {e}")),
          },
          Err(e) => ToolResult::error(e),
        }
      }
      AgentToolCall::LinkNodes(input) => {
        let Ok(src) = input.src_id.parse::<NodeId>() else {
          return ToolResult::error(format!("not a valid src_id: {:?}", input.src_id));
        };
        let Ok(dst) = input.dst_id.parse::<NodeId>() else {
          return ToolResult::error(format!("not a valid dst_id: {:?}", input.dst_id));
        };
        match self.link_nodes(src, dst).await {
          Ok((node, op)) => match serde_json::to_string(&node) {
            Ok(json) => ToolResult::ok_staged(json, op),
            Err(e) => ToolResult::error(format!("serialize: {e}")),
          },
          Err(e) => ToolResult::error(e),
        }
      }
      AgentToolCall::MoveSubtree(input) => {
        let Ok(id) = input.id.parse::<NodeId>() else {
          return ToolResult::error(format!("not a valid id: {:?}", input.id));
        };
        let Ok(new_parent) = input.new_parent_id.parse::<NodeId>() else {
          return ToolResult::error(format!(
            "not a valid new_parent_id: {:?}",
            input.new_parent_id
          ));
        };
        match self.move_subtree(id, new_parent).await {
          Ok((node, op)) => match serde_json::to_string(&node) {
            Ok(json) => ToolResult::ok_staged(json, op),
            Err(e) => ToolResult::error(format!("serialize: {e}")),
          },
          Err(e) => ToolResult::error(e),
        }
      }
    }
  }
}

/// Replay a journal onto the real vault. Stops on first error; earlier
/// ops in this accept remain applied (accept is best-effort ordered).
pub async fn flush_journal(
  service: &ForestService,
  journal: &[StagedOp],
) -> Result<usize, String> {
  let mut applied = 0usize;
  for op in journal {
    match op {
      StagedOp::CreateNode { node } => {
        // Write the exact shadow node (same ULID) so client-held ids stay valid.
        service
          .write_node_as_is(node)
          .await
          .map_err(|e| format!("create {}: {e}", node.id))?;
      }
      StagedOp::PatchNode { after, .. } => {
        let patch = NodePatch {
          title: Some(after.title.clone()),
          content: Some(after.content.clone()),
          node_type: Some(after.node_type),
          links: None,
          parent: None,
        };
        service
          .update_node(&after.id, patch)
          .await
          .map_err(|e| format!("patch {}: {e}", after.id))?;
      }
      StagedOp::LinkNodes { after, .. } => {
        let patch = NodePatch {
          links: Some(after.links.clone()),
          ..Default::default()
        };
        service
          .update_node(&after.id, patch)
          .await
          .map_err(|e| format!("link {}: {e}", after.id))?;
      }
      StagedOp::MoveSubtree { after, .. } => {
        let parent = after.parent.ok_or_else(|| {
          format!("move {}: after state has no parent", after.id)
        })?;
        let patch = NodePatch {
          parent: Some(parent),
          ..Default::default()
        };
        service
          .update_node(&after.id, patch)
          .await
          .map_err(|e| format!("move {}: {e}", after.id))?;
      }
    }
    applied += 1;
  }
  Ok(applied)
}
