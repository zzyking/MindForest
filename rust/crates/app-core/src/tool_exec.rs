//! H2 of the agent harness — the vault side of the tool seam
//! (`AGENT_HARNESS.md` §L2).
//!
//! Implements the agent crate's `ToolExecutor` over `ForestService`, so
//! the provider tool loop can run `mf_read_node` / `mf_search` against the
//! real vault without the agent crate ever depending on app-core. Every
//! outcome — bad id, missing node, index error — comes back as a
//! `ToolResult`, never a Rust error: the loop must always have a
//! `tool_result` to hand the model, and a tool failure is something the
//! model should see and can recover from, not a reason to drop the turn.

use agent::{AgentToolCall, ToolExecutor, ToolResult, DEFAULT_SEARCH_K};
use async_trait::async_trait;
use domain::NodeId;

use crate::ForestService;

/// Upper bound on `mf_search`'s `k`. A tool result is pasted back into the
/// model's context, so an unbounded `k` is both a cost and a
/// context-blowout risk; the model can always search again to go deeper.
const MAX_SEARCH_K: usize = 25;

#[async_trait]
impl ToolExecutor for ForestService {
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
          Err(e) => ToolResult::error(format!("could not read node {id}: {e}")),
        }
      }
      AgentToolCall::Search(input) => {
        // Vault-wide (no topic filter) so the model can find cross-topic
        // material — the whole point of giving it search.
        let k = input.k.unwrap_or(DEFAULT_SEARCH_K).clamp(1, MAX_SEARCH_K);
        match self.search(&input.query, None, k).await {
          Ok(hits) => match serde_json::to_string(&hits) {
            Ok(json) => ToolResult::ok(json),
            Err(e) => ToolResult::error(format!("could not serialize search hits: {e}")),
          },
          Err(e) => ToolResult::error(format!("search failed: {e}")),
        }
      }
    }
  }
}
