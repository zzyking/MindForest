//! Agent harness tool surface (`AGENT_HARNESS.md` §L2).
//!
//! **H2** — read-only: `mf_read_node`, `mf_search`.
//! **H3** — write tools on a shadow vault: `mf_create_node`, `mf_patch_node`,
//! `mf_link_nodes`, `mf_move_subtree`. Writes journal as `StagedOp`s;
//! accept flushes to the real vault.
//!
//! Pure types + dispatch seam. No `ForestService` here — app-core implements
//! `ToolExecutor` (shadow during propose, real vault only on accept).

use std::sync::Arc;

use async_trait::async_trait;
use domain::{Node, NodeId, NodeType};
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ─── Tool names ──────────────────────────────────────────────────────

pub const MF_READ_NODE: &str = "mf_read_node";
pub const MF_SEARCH: &str = "mf_search";
pub const MF_CREATE_NODE: &str = "mf_create_node";
pub const MF_PATCH_NODE: &str = "mf_patch_node";
pub const MF_LINK_NODES: &str = "mf_link_nodes";
pub const MF_MOVE_SUBTREE: &str = "mf_move_subtree";

pub const DEFAULT_SEARCH_K: usize = 8;
pub const DEFAULT_MAX_TOOL_CALLS: usize = 20;

// ─── Schemas advertised to the model ─────────────────────────────────

#[derive(Debug, Clone)]
pub struct ToolDef {
  pub name: &'static str,
  pub description: &'static str,
  pub input_schema: Value,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct ReadNodeInput {
  /// ULID of the node to read (26 chars).
  pub id: String,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct SearchInput {
  pub query: String,
  #[serde(default)]
  pub k: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct CreateNodeInput {
  /// Parent node ULID (existing vault id or one returned by an earlier
  /// `mf_create_node` in this turn).
  pub parent_id: String,
  pub title: String,
  /// concept | idea | fact | source | example | question | task | misc
  #[serde(default, rename = "type")]
  pub node_type: Option<String>,
  #[serde(default)]
  pub content: Option<String>,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct PatchNodeInput {
  pub id: String,
  #[serde(default)]
  pub title: Option<String>,
  #[serde(default)]
  pub content: Option<String>,
  #[serde(default, rename = "type")]
  pub node_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct LinkNodesInput {
  pub src_id: String,
  pub dst_id: String,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct MoveSubtreeInput {
  pub id: String,
  pub new_parent_id: String,
}

// ─── Parsed calls ────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum AgentToolCall {
  ReadNode(ReadNodeInput),
  Search(SearchInput),
  CreateNode(CreateNodeInput),
  PatchNode(PatchNodeInput),
  LinkNodes(LinkNodesInput),
  MoveSubtree(MoveSubtreeInput),
}

impl AgentToolCall {
  pub fn parse(name: &str, input: Value) -> Option<Result<Self, serde_json::Error>> {
    match name {
      MF_READ_NODE => Some(serde_json::from_value(input).map(AgentToolCall::ReadNode)),
      MF_SEARCH => Some(serde_json::from_value(input).map(AgentToolCall::Search)),
      MF_CREATE_NODE => Some(serde_json::from_value(input).map(AgentToolCall::CreateNode)),
      MF_PATCH_NODE => Some(serde_json::from_value(input).map(AgentToolCall::PatchNode)),
      MF_LINK_NODES => Some(serde_json::from_value(input).map(AgentToolCall::LinkNodes)),
      MF_MOVE_SUBTREE => Some(serde_json::from_value(input).map(AgentToolCall::MoveSubtree)),
      _ => None,
    }
  }

  pub fn name(&self) -> &'static str {
    match self {
      AgentToolCall::ReadNode(_) => MF_READ_NODE,
      AgentToolCall::Search(_) => MF_SEARCH,
      AgentToolCall::CreateNode(_) => MF_CREATE_NODE,
      AgentToolCall::PatchNode(_) => MF_PATCH_NODE,
      AgentToolCall::LinkNodes(_) => MF_LINK_NODES,
      AgentToolCall::MoveSubtree(_) => MF_MOVE_SUBTREE,
    }
  }

  /// True for tools that mutate the (shadow) vault and should surface as
  /// a staged-diff row in the UI.
  pub fn is_write(&self) -> bool {
    matches!(
      self,
      AgentToolCall::CreateNode(_)
        | AgentToolCall::PatchNode(_)
        | AgentToolCall::LinkNodes(_)
        | AgentToolCall::MoveSubtree(_)
    )
  }
}

// ─── Tool catalogs ───────────────────────────────────────────────────

pub fn read_only_tools() -> Vec<ToolDef> {
  vec![
    ToolDef {
      name: MF_READ_NODE,
      description: "Read one node in full by its ULID: title, type, the complete markdown body, and its links. Use it before editing a node whose full content you haven't seen — the vault-context block only carries excerpts.",
      input_schema: schema_of::<ReadNodeInput>(),
    },
    ToolDef {
      name: MF_SEARCH,
      description: "Search the whole vault (every topic) by meaning and keyword. Returns the top matches as id + topic + title + snippet. Use it to find already-existing related nodes before drafting.",
      input_schema: schema_of::<SearchInput>(),
    },
  ]
}

pub fn write_tools() -> Vec<ToolDef> {
  vec![
    ToolDef {
      name: MF_CREATE_NODE,
      description: "Create a child node under parent_id. Returns the new node JSON including its assigned ULID — use that id as parent_id for further children in this turn. Changes are staged until the user accepts.",
      input_schema: schema_of::<CreateNodeInput>(),
    },
    ToolDef {
      name: MF_PATCH_NODE,
      description: "Update an existing node's title, content, and/or type. Omit fields you don't want to change. Staged until accept.",
      input_schema: schema_of::<PatchNodeInput>(),
    },
    ToolDef {
      name: MF_LINK_NODES,
      description: "Add a graph link from src_id to dst_id (directed). Staged until accept.",
      input_schema: schema_of::<LinkNodesInput>(),
    },
    ToolDef {
      name: MF_MOVE_SUBTREE,
      description: "Reparent node id under new_parent_id (moves the whole subtree). Same-topic only; cannot move the topic root. Staged until accept.",
      input_schema: schema_of::<MoveSubtreeInput>(),
    },
  ]
}

/// H3 full tool set: reads then writes, in advertisement order.
pub fn full_tools() -> Vec<ToolDef> {
  let mut t = read_only_tools();
  t.extend(write_tools());
  t
}

// ─── Staged ops (wire + journal) ─────────────────────────────────────

/// One vault mutation journaled by the shadow and shown in the UI as a
/// staged-diff row. Accept replays these in order onto the real vault.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum StagedOp {
  CreateNode { node: Node },
  PatchNode { before: Node, after: Node },
  LinkNodes {
    src_id: NodeId,
    dst_id: NodeId,
    /// Source node after the link was added (for accept + UI).
    after: Node,
  },
  MoveSubtree { before: Node, after: Node },
}

impl StagedOp {
  pub fn summary_title(&self) -> &str {
    match self {
      StagedOp::CreateNode { node } => &node.title,
      StagedOp::PatchNode { after, .. } => &after.title,
      StagedOp::LinkNodes { after, .. } => &after.title,
      StagedOp::MoveSubtree { after, .. } => &after.title,
    }
  }
}

// ─── Tool result ─────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ToolResult {
  pub content: String,
  pub is_error: bool,
  /// When set, the provider loop also emits `AgentEvent::StagedDiff`.
  pub staged: Option<StagedOp>,
}

impl ToolResult {
  pub fn ok(content: String) -> Self {
    Self {
      content,
      is_error: false,
      staged: None,
    }
  }

  pub fn ok_staged(content: String, staged: StagedOp) -> Self {
    Self {
      content,
      is_error: false,
      staged: Some(staged),
    }
  }

  pub fn error(message: impl Into<String>) -> Self {
    Self {
      content: serde_json::json!({ "error": message.into() }).to_string(),
      is_error: true,
      staged: None,
    }
  }
}

#[async_trait]
pub trait ToolExecutor: Send + Sync {
  async fn execute(&self, call: AgentToolCall) -> ToolResult;
}

/// Per-turn tool handle passed into `AgentProposer::propose`.
pub struct ToolSession {
  pub tools: Vec<ToolDef>,
  pub executor: Arc<dyn ToolExecutor>,
  pub max_tool_calls: usize,
  /// Staging turn id (H3). Present when write tools are active so the
  /// provider loop can attach it to `StagedDiff` events.
  pub turn_id: Option<String>,
}

impl ToolSession {
  pub fn read_only(executor: Arc<dyn ToolExecutor>) -> Self {
    Self {
      tools: read_only_tools(),
      executor,
      max_tool_calls: DEFAULT_MAX_TOOL_CALLS,
      turn_id: None,
    }
  }

  /// H3: read + write tools against a shadow executor.
  pub fn full(executor: Arc<dyn ToolExecutor>, turn_id: String) -> Self {
    Self {
      tools: full_tools(),
      executor,
      max_tool_calls: DEFAULT_MAX_TOOL_CALLS,
      turn_id: Some(turn_id),
    }
  }
}

pub async fn dispatch_tool(
  executor: &dyn ToolExecutor,
  name: &str,
  input: Value,
) -> ToolResult {
  match AgentToolCall::parse(name, input) {
    None => ToolResult::error(format!("unknown tool: {name}")),
    Some(Err(e)) => ToolResult::error(format!("invalid input for {name}: {e}")),
    Some(Ok(call)) => executor.execute(call).await,
  }
}

fn schema_of<T: schemars::JsonSchema>() -> Value {
  serde_json::to_value(schemars::schema_for!(T)).unwrap_or_else(|_| serde_json::json!({}))
}

pub fn openai_tools_array(tools: &[ToolDef]) -> Value {
  Value::Array(
    tools
      .iter()
      .map(|t| {
        serde_json::json!({
          "type": "function",
          "function": {
            "name": t.name,
            "description": t.description,
            "parameters": t.input_schema,
          }
        })
      })
      .collect(),
  )
}

pub fn anthropic_tools_array(tools: &[ToolDef]) -> Value {
  Value::Array(
    tools
      .iter()
      .map(|t| {
        serde_json::json!({
          "name": t.name,
          "description": t.description,
          "input_schema": t.input_schema,
        })
      })
      .collect(),
  )
}

/// Parse a wire `type` string into `NodeType`. Unknown → error string.
pub fn parse_node_type(raw: Option<&str>) -> Result<NodeType, String> {
  let Some(s) = raw else {
    return Ok(NodeType::Concept);
  };
  match s {
    "concept" => Ok(NodeType::Concept),
    "idea" => Ok(NodeType::Idea),
    "fact" => Ok(NodeType::Fact),
    "source" => Ok(NodeType::Source),
    "example" => Ok(NodeType::Example),
    "question" => Ok(NodeType::Question),
    "task" => Ok(NodeType::Task),
    "misc" => Ok(NodeType::Misc),
    other => Err(format!("unknown node type: {other}")),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn parse_dispatches_known_tools() {
    let call = AgentToolCall::parse(MF_READ_NODE, json!({ "id": "01ABC" }))
      .expect("known tool")
      .expect("valid input");
    assert!(matches!(call, AgentToolCall::ReadNode(_)));

    let call = AgentToolCall::parse(
      MF_CREATE_NODE,
      json!({ "parent_id": "01ABC", "title": "X", "type": "concept" }),
    )
    .expect("known")
    .expect("valid");
    assert!(call.is_write());
    assert_eq!(call.name(), MF_CREATE_NODE);
  }

  #[test]
  fn parse_search_k_is_optional() {
    let AgentToolCall::Search(input) =
      AgentToolCall::parse(MF_SEARCH, json!({ "query": "x" })).unwrap().unwrap()
    else {
      panic!("expected search");
    };
    assert_eq!(input.k, None);
  }

  #[test]
  fn parse_unknown_tool_is_none() {
    assert!(AgentToolCall::parse("mf_delete_everything", json!({})).is_none());
  }

  #[test]
  fn parse_bad_input_is_some_err() {
    let outcome = AgentToolCall::parse(MF_READ_NODE, json!({ "wrong": "field" }));
    assert!(matches!(outcome, Some(Err(_))));
  }

  #[test]
  fn full_tools_include_reads_and_writes() {
    let names: Vec<_> = full_tools().iter().map(|t| t.name).collect();
    assert_eq!(
      names,
      vec![
        MF_READ_NODE,
        MF_SEARCH,
        MF_CREATE_NODE,
        MF_PATCH_NODE,
        MF_LINK_NODES,
        MF_MOVE_SUBTREE,
      ]
    );
  }

  #[test]
  fn tool_result_error_is_valid_json_and_flagged() {
    let r = ToolResult::error("node not found");
    assert!(r.is_error);
    let v: Value = serde_json::from_str(&r.content).unwrap();
    assert_eq!(v["error"], "node not found");
  }

  struct EchoExecutor;

  #[async_trait]
  impl ToolExecutor for EchoExecutor {
    async fn execute(&self, call: AgentToolCall) -> ToolResult {
      ToolResult::ok(format!("echo:{}", call.name()))
    }
  }

  #[tokio::test]
  async fn dispatch_unknown_and_bad_input_are_errors() {
    let ex = EchoExecutor;
    let r = dispatch_tool(&ex, "mf_nope", json!({})).await;
    assert!(r.is_error);
    let r = dispatch_tool(&ex, MF_READ_NODE, json!({ "wrong": 1 })).await;
    assert!(r.is_error);
  }

  #[tokio::test]
  async fn dispatch_known_tool_hits_executor() {
    let ex = EchoExecutor;
    let r = dispatch_tool(&ex, MF_READ_NODE, json!({ "id": "01ABC" })).await;
    assert!(!r.is_error);
    assert_eq!(r.content, format!("echo:{MF_READ_NODE}"));
  }

  #[test]
  fn parse_node_type_defaults_and_rejects() {
    assert!(matches!(parse_node_type(None), Ok(NodeType::Concept)));
    assert!(matches!(parse_node_type(Some("question")), Ok(NodeType::Question)));
    assert!(parse_node_type(Some("nope")).is_err());
  }
}
