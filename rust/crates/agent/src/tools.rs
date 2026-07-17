//! H2 of the agent harness — the read-only tool surface
//! (`AGENT_HARNESS.md` §L2).
//!
//! Two narrow tools the provider can call to look around the vault before
//! it proposes: `mf_read_node` and `mf_search`. This module is *pure
//! types* — what the provider is told about (`ToolDef` + input schemas),
//! the parsed call the backend dispatches (`AgentToolCall`), the
//! `ToolExecutor` seam that app-core implements over `ForestService`,
//! and the `ToolSession` the provider loop holds for one turn.
//!
//! The executor trait lives here, not in app-core, on purpose: the
//! provider tool loop (this crate) holds a `dyn ToolExecutor` and calls
//! it, so putting the trait here keeps the dependency arrow pointing the
//! one way it already points (`app-core → agent`). No provider wire
//! format and no `ForestService` leak into this file.

use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;

/// Tool name constants — the single source of truth shared by the schema
/// advertised to the model and the dispatch that parses its calls back.
pub const MF_READ_NODE: &str = "mf_read_node";
pub const MF_SEARCH: &str = "mf_search";

/// Default `k` for `mf_search` when the model omits it. Mirrors the
/// harness doc's tool table.
pub const DEFAULT_SEARCH_K: usize = 8;

/// One tool advertised to the provider: a name, a one-line description,
/// and the JSON Schema for its input object. Each provider adapter
/// translates this into its own `tools` array shape (Anthropic's
/// `input_schema`, OpenAI's `function.parameters`).
#[derive(Debug, Clone)]
pub struct ToolDef {
  pub name: &'static str,
  pub description: &'static str,
  pub input_schema: Value,
}

/// Input for `mf_read_node`. The id is a plain string on the wire; the
/// executor parses it to a `NodeId`. An unparseable id is a *tool* error
/// (a `tool_result` the model can react to), not a deserialize failure
/// that would drop the whole turn — so it stays a `String` here.
#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct ReadNodeInput {
  /// ULID of the node to read (26 chars), e.g. from a search hit or the
  /// `<vault-context>` block.
  pub id: String,
}

/// Input for `mf_search`. Hybrid FTS + vector search across the whole
/// vault (all topics), the same engine that backs the app's search
/// palette.
#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct SearchInput {
  /// Natural-language or keyword query.
  pub query: String,
  /// Max hits to return. Omitted → `DEFAULT_SEARCH_K`.
  #[serde(default)]
  pub k: Option<usize>,
}

/// A tool call the model made, parsed from the provider's `tool_use`
/// block into a typed, dispatch-ready value.
#[derive(Debug, Clone)]
pub enum AgentToolCall {
  ReadNode(ReadNodeInput),
  Search(SearchInput),
}

impl AgentToolCall {
  /// Parse a provider tool_use (`name` + its JSON `input`) into a typed
  /// call. Layered so the loop can react precisely:
  ///
  /// - `None` — unknown tool name (model hallucinated a tool).
  /// - `Some(Err)` — known tool, but the input doesn't match its schema.
  /// - `Some(Ok(call))` — ready to dispatch.
  ///
  /// Both failure arms become an `is_error` `tool_result` upstream, never
  /// a dropped turn.
  pub fn parse(name: &str, input: Value) -> Option<Result<Self, serde_json::Error>> {
    match name {
      MF_READ_NODE => Some(serde_json::from_value(input).map(AgentToolCall::ReadNode)),
      MF_SEARCH => Some(serde_json::from_value(input).map(AgentToolCall::Search)),
      _ => None,
    }
  }

  /// The advertised name of this call's tool — for labelling the SSE
  /// `tool_call` event and error messages without re-matching.
  pub fn name(&self) -> &'static str {
    match self {
      AgentToolCall::ReadNode(_) => MF_READ_NODE,
      AgentToolCall::Search(_) => MF_SEARCH,
    }
  }
}

/// The read-only tool set for H2, in the order advertised to the model.
/// H3 appends the write tools; H4 appends `mf_code_map`.
pub fn read_only_tools() -> Vec<ToolDef> {
  vec![
    ToolDef {
      name: MF_READ_NODE,
      description: "Read one node in full by its ULID: title, type, the complete markdown body, and its links. Use it before proposing an edit to a node whose full content you haven't seen — the vault-context block only carries excerpts.",
      input_schema: schema_of::<ReadNodeInput>(),
    },
    ToolDef {
      name: MF_SEARCH,
      description: "Search the whole vault (every topic) by meaning and keyword. Returns the top matches as id + topic + title + snippet. Use it to find already-existing related nodes before drafting, so you build on them and propose cross-topic links instead of duplicating them.",
      input_schema: schema_of::<SearchInput>(),
    },
  ]
}

/// The outcome of executing a tool, ready to hand back to the provider as
/// a `tool_result`. `content` is JSON text (a serialized `Node`, an array
/// of search hits, or `{"error": "..."}`); `is_error` maps to the
/// provider's tool-result error flag so the model learns the call failed
/// while the turn continues.
#[derive(Debug, Clone)]
pub struct ToolResult {
  pub content: String,
  pub is_error: bool,
}

impl ToolResult {
  /// A successful result carrying already-serialized JSON `content`.
  pub fn ok(content: String) -> Self {
    Self {
      content,
      is_error: false,
    }
  }

  /// An error the model should see and can recover from (bad id, node not
  /// found, …). Wrapped as `{"error": "<message>"}` so the content is
  /// always valid JSON regardless of the arm.
  pub fn error(message: impl Into<String>) -> Self {
    Self {
      content: serde_json::json!({ "error": message.into() }).to_string(),
      is_error: true,
    }
  }
}

/// The seam between the provider tool loop (this crate) and the vault
/// (app-core). The loop calls `execute` once per `tool_use`; the app-core
/// impl runs it against `ForestService` and serializes the result. A
/// tool-level failure is returned as `ToolResult { is_error: true }`, not
/// as a Rust error — the loop must always have something to feed back.
#[async_trait]
pub trait ToolExecutor: Send + Sync {
  async fn execute(&self, call: AgentToolCall) -> ToolResult;
}

/// Default ceiling on tool *executions* per propose turn
/// (`AGENT_HARNESS.md` §7). Without a budget a bad prompt can spiral.
pub const DEFAULT_MAX_TOOL_CALLS: usize = 20;

/// Everything the provider loop needs to advertise tools and run them
/// for one propose turn. Built by app-core (`ToolSession::read_only`)
/// and passed into `AgentProposer::propose`. Not serializable — the
/// executor is a live vault handle.
pub struct ToolSession {
  pub tools: Vec<ToolDef>,
  pub executor: Arc<dyn ToolExecutor>,
  /// Hard cap on how many tool calls the loop will execute this turn.
  /// Further `tool_use` blocks from the model are ignored and the loop
  /// ends with whatever text/proposals it has so far.
  pub max_tool_calls: usize,
}

impl ToolSession {
  /// H2 session: the two read-only tools against the given executor.
  pub fn read_only(executor: Arc<dyn ToolExecutor>) -> Self {
    Self {
      tools: read_only_tools(),
      executor,
      max_tool_calls: DEFAULT_MAX_TOOL_CALLS,
    }
  }
}

/// Parse a provider tool_use (`name` + JSON `input`) and run it. Unknown
/// names and schema mismatches become `is_error` results the model can
/// recover from — never a dropped turn.
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

/// Render a tool-input type's JSON Schema as a plain `serde_json::Value`
/// for inlining into a provider's `tools` array. `schema_for!` is
/// infallible to build and the result always serializes, so a failure
/// here would be a bug in schemars, not runtime data — degrade to an
/// empty object rather than panic.
fn schema_of<T: schemars::JsonSchema>() -> Value {
  serde_json::to_value(schemars::schema_for!(T)).unwrap_or_else(|_| serde_json::json!({}))
}

/// OpenAI / OpenAI-compatible `tools` array entry shape
/// (`type: "function"` + nested `function.{name,description,parameters}`).
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

/// Anthropic `/v1/messages` `tools` array entry shape
/// (`name` + `description` + `input_schema` at the top level).
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
    assert_eq!(call.name(), MF_READ_NODE);

    let call = AgentToolCall::parse(MF_SEARCH, json!({ "query": "tokenization" }))
      .expect("known tool")
      .expect("valid input");
    assert!(matches!(call, AgentToolCall::Search(_)));
  }

  #[test]
  fn parse_search_k_is_optional() {
    let AgentToolCall::Search(input) =
      AgentToolCall::parse(MF_SEARCH, json!({ "query": "x" })).unwrap().unwrap()
    else {
      panic!("expected search");
    };
    assert_eq!(input.k, None); // caller substitutes DEFAULT_SEARCH_K
  }

  #[test]
  fn parse_unknown_tool_is_none() {
    assert!(AgentToolCall::parse("mf_delete_everything", json!({})).is_none());
  }

  #[test]
  fn parse_bad_input_is_some_err() {
    // Known tool, but `id` is required and missing.
    let outcome = AgentToolCall::parse(MF_READ_NODE, json!({ "wrong": "field" }));
    assert!(matches!(outcome, Some(Err(_))));
  }

  #[test]
  fn read_only_tools_are_the_two_named_read_tools_with_schemas() {
    let tools = read_only_tools();
    let names: Vec<_> = tools.iter().map(|t| t.name).collect();
    assert_eq!(names, vec![MF_READ_NODE, MF_SEARCH]);
    for t in &tools {
      assert!(!t.description.is_empty());
      // Each schema is an object describing the input's properties.
      assert!(t.input_schema.get("properties").is_some(), "{} has no properties", t.name);
    }
  }

  #[test]
  fn tool_result_error_is_valid_json_and_flagged() {
    let r = ToolResult::error("node not found");
    assert!(r.is_error);
    let v: Value = serde_json::from_str(&r.content).unwrap();
    assert_eq!(v["error"], "node not found");
    assert!(!ToolResult::ok("{}".into()).is_error);
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
    assert!(r.content.contains("unknown tool"));

    let r = dispatch_tool(&ex, MF_READ_NODE, json!({ "wrong": 1 })).await;
    assert!(r.is_error);
    assert!(r.content.contains("invalid input"));
  }

  #[tokio::test]
  async fn dispatch_known_tool_hits_executor() {
    let ex = EchoExecutor;
    let r = dispatch_tool(&ex, MF_READ_NODE, json!({ "id": "01ABC" })).await;
    assert!(!r.is_error);
    assert_eq!(r.content, format!("echo:{MF_READ_NODE}"));
  }
}
