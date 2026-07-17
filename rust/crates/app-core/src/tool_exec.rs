//! H2 read tools on the real vault. Write tools only run on `ShadowForest`
//! (see `shadow.rs`); calling them here is a programming error and returns
//! a tool-level error rather than mutating disk mid-stream.

use agent::{AgentToolCall, ToolExecutor, ToolResult, DEFAULT_SEARCH_K};
use async_trait::async_trait;
use domain::NodeId;

use crate::ForestService;

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
        let k = input.k.unwrap_or(DEFAULT_SEARCH_K).clamp(1, MAX_SEARCH_K);
        match self.search(&input.query, None, k).await {
          Ok(hits) => match serde_json::to_string(&hits) {
            Ok(json) => ToolResult::ok(json),
            Err(e) => ToolResult::error(format!("could not serialize search hits: {e}")),
          },
          Err(e) => ToolResult::error(format!("search failed: {e}")),
        }
      }
      AgentToolCall::CreateNode(_)
      | AgentToolCall::PatchNode(_)
      | AgentToolCall::LinkNodes(_)
      | AgentToolCall::MoveSubtree(_) => ToolResult::error(
        "write tools must run on the shadow vault during propose; use accept_staged_turn to flush",
      ),
    }
  }
}
