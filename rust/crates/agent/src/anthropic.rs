//! Anthropic `/v1/messages` provider.
//!
//! ## Streaming
//!
//! With `"stream": true` Anthropic emits named SSE events. Text tokens
//! arrive as `content_block_delta` / `text_delta`; tool-arg fragments as
//! `input_json_delta` under a `tool_use` content block. Same multi-round
//! tool loop as the OpenAI adapter when a `ToolSession` is supplied.

use async_trait::async_trait;
use domain::ForestResult;
use futures::StreamExt;
use serde_json::{json, Value};

use crate::prompt::{build_user_message, system_prompt_for};
use crate::sse::into_event_stream;
use crate::tools::{anthropic_tools_array, dispatch_tool};
use crate::{
  extract_proposals, AgentEvent, AgentProposer, AgentRequest, AgentRole, AgentStream, ToolSession,
};

const DEFAULT_API_BASE: &str = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Clone)]
pub struct AnthropicConfig {
  /// Defaults to `https://api.anthropic.com/v1`. Overridable mainly so
  /// tests can point at a mock.
  pub base_url: String,
  pub api_key: String,
  pub model: String,
  /// Anthropic models require an explicit max_tokens. 16k fits a tree
  /// of ~12–18 detailed proposals (each with 100–300 words of content)
  /// plus the agent's reasoning preamble. Even with the cap a long-tail
  /// reply can still get truncated; `extract_proposals` salvages the
  /// closed-object prefix so the user sees the work that did make it
  /// through.
  pub max_tokens: u32,
}

impl AnthropicConfig {
  pub fn new(api_key: String, model: String) -> Self {
    Self {
      base_url: DEFAULT_API_BASE.into(),
      api_key,
      model,
      max_tokens: 16384,
    }
  }
}

pub struct AnthropicProposer {
  cfg: AnthropicConfig,
  client: reqwest::Client,
  backend_label: String,
}

impl AnthropicProposer {
  pub fn new(cfg: AnthropicConfig) -> Self {
    let backend_label = format!("{} (anthropic)", cfg.model);
    Self {
      cfg,
      client: reqwest::Client::new(),
      backend_label,
    }
  }
}

#[derive(Debug, Default, Clone)]
struct AccumToolUse {
  id: String,
  name: String,
  input_json: String,
}

struct RoundOutcome {
  text: String,
  tool_uses: Vec<AccumToolUse>,
  /// Anthropic `message_delta.stop_reason`: `end_turn` | `tool_use` | …
  stop_reason: Option<String>,
}

#[async_trait]
impl AgentProposer for AnthropicProposer {
  async fn propose(
    &self,
    req: AgentRequest,
    tools: Option<ToolSession>,
  ) -> ForestResult<AgentStream> {
    let url = format!("{}/messages", self.cfg.base_url.trim_end_matches('/'));
    let client = self.client.clone();
    let api_key = self.cfg.api_key.clone();
    let model = self.cfg.model.clone();
    let max_tokens = self.cfg.max_tokens;
    let has_tools = tools.is_some();
    let system = system_prompt_for(has_tools);

    let mut messages: Vec<Value> = Vec::with_capacity(req.history.len() + 1);
    for turn in &req.history {
      messages.push(json!({
        "role": match turn.role {
          AgentRole::User => "user",
          AgentRole::Assistant => "assistant",
        },
        "content": turn.text,
      }));
    }
    messages.push(json!({ "role": "user", "content": build_user_message(&req) }));

    Ok(Box::pin(async_stream::stream! {
      let mut messages = messages;
      let mut all_text = String::new();
      let mut calls_used: usize = 0;
      let max_calls = tools.as_ref().map(|t| t.max_tool_calls).unwrap_or(0);
      let tools_json = tools.as_ref().map(|t| anthropic_tools_array(&t.tools));
      if let Some(tid) = tools.as_ref().and_then(|t| t.turn_id.clone()) {
        yield AgentEvent::TurnStarted { turn_id: tid };
      }

      loop {
        let mut body = json!({
          "model": model,
          "max_tokens": max_tokens,
          "stream": true,
          "system": system,
          "messages": messages,
        });
        if let Some(ref t) = tools_json {
          body["tools"] = t.clone();
        }

        let resp = match client
          .post(&url)
          .header("x-api-key", &api_key)
          .header("anthropic-version", ANTHROPIC_VERSION)
          .json(&body)
          .send()
          .await
        {
          Ok(r) => r,
          Err(e) => {
            yield AgentEvent::Error { message: format!("anthropic connect: {e}") };
            yield AgentEvent::Done;
            return;
          }
        };
        if !resp.status().is_success() {
          let status = resp.status();
          let body = resp.text().await.unwrap_or_default();
          yield AgentEvent::Error {
            message: format!("anthropic upstream {status}: {body}"),
          };
          yield AgentEvent::Done;
          return;
        }

        let outcome = match stream_anthropic_round(resp.bytes_stream()).await {
          Ok(o) => o,
          Err(e) => {
            yield AgentEvent::Error { message: e };
            yield AgentEvent::Done;
            return;
          }
        };

        if !outcome.text.is_empty() {
          all_text.push_str(&outcome.text);
          yield AgentEvent::Token { text: outcome.text.clone() };
        }

        let wants_tools = outcome.stop_reason.as_deref() == Some("tool_use")
          || !outcome.tool_uses.is_empty();

        if !wants_tools || tools.is_none() {
          break;
        }

        let session = tools.as_ref().unwrap();
        if calls_used >= max_calls {
          yield AgentEvent::Error {
            message: format!(
              "tool-call budget exhausted ({max_calls}); stopping without further tools"
            ),
          };
          break;
        }

        // Assistant content blocks: optional text + each tool_use.
        let mut content_blocks: Vec<Value> = Vec::new();
        if !outcome.text.is_empty() {
          content_blocks.push(json!({ "type": "text", "text": outcome.text }));
        }

        let mut tool_results: Vec<Value> = Vec::new();
        for tu in &outcome.tool_uses {
          if calls_used >= max_calls {
            break;
          }
          calls_used += 1;

          let input: Value = serde_json::from_str(&tu.input_json)
            .unwrap_or_else(|_| json!({}));
          yield AgentEvent::ToolCallPending {
            id: tu.id.clone(),
            name: tu.name.clone(),
            input: input.clone(),
          };

          let result = dispatch_tool(session.executor.as_ref(), &tu.name, input).await;
          yield AgentEvent::ToolResult {
            id: tu.id.clone(),
            name: tu.name.clone(),
            content: result.content.clone(),
            is_error: result.is_error,
          };
          if let (Some(op), Some(turn_id)) = (result.staged, session.turn_id.as_ref()) {
            yield AgentEvent::StagedDiff {
              turn_id: turn_id.clone(),
              tool_call_id: tu.id.clone(),
              op,
            };
          }

          content_blocks.push(json!({
            "type": "tool_use",
            "id": tu.id,
            "name": tu.name,
            "input": serde_json::from_str::<Value>(&tu.input_json)
              .unwrap_or_else(|_| json!({})),
          }));
          let mut tr = json!({
            "type": "tool_result",
            "tool_use_id": tu.id,
            "content": result.content,
          });
          if result.is_error {
            tr["is_error"] = json!(true);
          }
          tool_results.push(tr);
        }

        if tool_results.is_empty() {
          break;
        }

        messages.push(json!({
          "role": "assistant",
          "content": content_blocks,
        }));
        messages.push(json!({
          "role": "user",
          "content": tool_results,
        }));
      }

      match extract_proposals(&all_text) {
        Ok(props) => {
          for p in props {
            yield AgentEvent::Proposal { proposal: p };
          }
        }
        Err(e) => {
          yield AgentEvent::Error { message: format!("parse proposals: {e}") };
        }
      }
      yield AgentEvent::Done;
    }))
  }

  fn backend(&self) -> &str {
    &self.backend_label
  }
}

async fn stream_anthropic_round<S>(byte_stream: S) -> Result<RoundOutcome, String>
where
  S: futures::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send + 'static,
{
  let mut text = String::new();
  let mut tool_uses: Vec<AccumToolUse> = Vec::new();
  // Index of the content block currently being streamed (from
  // `content_block_start.index`).
  let mut current_index: Option<usize> = None;
  // Maps content-block index → slot in `tool_uses`.
  let mut index_to_tool: std::collections::HashMap<usize, usize> =
    std::collections::HashMap::new();
  let mut stop_reason: Option<String> = None;
  let mut event_stream = into_event_stream(byte_stream);

  while let Some(item) = event_stream.next().await {
    let ev = item.map_err(|e| format!("anthropic stream: {e}"))?;
    match ev.event.as_deref() {
      Some("content_block_start") => {
        let val: Value = match serde_json::from_str(&ev.data) {
          Ok(v) => v,
          Err(_) => continue,
        };
        let index = val.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
        current_index = Some(index);
        let block = val.get("content_block").cloned().unwrap_or(Value::Null);
        if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
          let id = block
            .get("id")
            .and_then(|i| i.as_str())
            .unwrap_or("")
            .to_string();
          let name = block
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string();
          let slot = tool_uses.len();
          tool_uses.push(AccumToolUse {
            id,
            name,
            input_json: String::new(),
          });
          index_to_tool.insert(index, slot);
        }
      }
      Some("content_block_delta") => {
        let val: Value = match serde_json::from_str(&ev.data) {
          Ok(v) => v,
          Err(_) => continue,
        };
        let delta = val.get("delta").cloned().unwrap_or(Value::Null);
        match delta.get("type").and_then(|t| t.as_str()) {
          Some("text_delta") => {
            if let Some(t) = delta.get("text").and_then(|t| t.as_str()) {
              if !t.is_empty() {
                text.push_str(t);
              }
            }
          }
          Some("input_json_delta") => {
            if let Some(partial) = delta.get("partial_json").and_then(|p| p.as_str()) {
              let index = val
                .get("index")
                .and_then(|i| i.as_u64())
                .map(|i| i as usize)
                .or(current_index);
              if let Some(idx) = index {
                if let Some(&slot) = index_to_tool.get(&idx) {
                  tool_uses[slot].input_json.push_str(partial);
                }
              }
            }
          }
          _ => {}
        }
      }
      Some("message_delta") => {
        if let Ok(val) = serde_json::from_str::<Value>(&ev.data) {
          if let Some(sr) = val
            .get("delta")
            .and_then(|d| d.get("stop_reason"))
            .and_then(|s| s.as_str())
          {
            stop_reason = Some(sr.to_string());
          }
        }
      }
      Some("message_stop") => break,
      Some("error") => {
        return Err(format!("anthropic error event: {}", ev.data));
      }
      _ => {}
    }
  }

  // Drop empty-name tool uses (malformed stream).
  tool_uses.retain(|t| !t.name.is_empty());

  Ok(RoundOutcome {
    text,
    tool_uses,
    stop_reason,
  })
}
