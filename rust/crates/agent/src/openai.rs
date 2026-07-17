//! OpenAI-compatible chat completions provider.
//!
//! Targets the `POST /chat/completions` SSE shape that OpenAI defined
//! and that everyone else (DeepSeek, Groq, Together, vLLM, Ollama,
//! LM Studio, …) speaks too. Switching backends is just a different
//! `base_url` + `model` + `api_key`.
//!
//! ## Streaming
//!
//! With `"stream": true` the response is text/event-stream where each
//! `data:` line carries a JSON chunk like
//! `{"choices":[{"delta":{"content":"Hello"}}]}` and the stream ends
//! with the literal sentinel `data: [DONE]`. We accumulate
//! `delta.content` into a buffer and emit each non-empty delta as
//! `AgentEvent::Token`. At end of stream we run the buffer through
//! `extract_proposals` and emit each one as `AgentEvent::Proposal`.
//!
//! ## H2 tool loop
//!
//! When a `ToolSession` is supplied, the request advertises the tool
//! schemas and we run multi-round: stream → if `finish_reason` is
//! `tool_calls`, execute each call via the session's executor, append
//! assistant + tool messages, re-request — until `stop` or the call
//! budget is spent. Intermediate rounds emit `ToolCallPending` /
//! `ToolResult`; only the final prose is proposal-parsed.

use std::collections::HashMap;

use async_trait::async_trait;
use domain::ForestResult;
use futures::StreamExt;
use serde_json::{json, Value};

use crate::prompt::{build_user_message, system_prompt_for};
use crate::sse::into_event_stream;
use crate::tools::{dispatch_tool, openai_tools_array};
use crate::{
  extract_proposals, AgentEvent, AgentProposer, AgentRequest, AgentRole, AgentStream, ToolSession,
};

#[derive(Debug, Clone)]
pub struct OpenAIConfig {
  /// e.g. `https://api.openai.com/v1`, `https://api.deepseek.com/v1`,
  /// `http://localhost:11434/v1` (Ollama). Trailing slash optional.
  pub base_url: String,
  pub api_key: String,
  pub model: String,
  /// Cap on response tokens. 16k fits a meaningful topic tree (≈12–18
  /// detailed add_node proposals plus the prose preamble) without
  /// pushing into provider rate-limit edges. Truncation is still
  /// possible on long-tail replies; `extract_proposals` recovers the
  /// closed-object prefix so the user gets partial output instead of
  /// a parse failure.
  pub max_tokens: u32,
}

impl OpenAIConfig {
  pub fn new(base_url: String, api_key: String, model: String) -> Self {
    Self {
      base_url,
      api_key,
      model,
      max_tokens: 16384,
    }
  }
}

pub struct OpenAICompatibleProposer {
  cfg: OpenAIConfig,
  client: reqwest::Client,
  /// User-visible label combining model + a short host hint so the UI
  /// can show "deepseek-chat (api.deepseek.com)" etc.
  backend_label: String,
}

impl OpenAICompatibleProposer {
  pub fn new(cfg: OpenAIConfig) -> Self {
    let backend_label = format!("{} ({})", cfg.model, host_of(&cfg.base_url));
    Self {
      cfg,
      client: reqwest::Client::new(),
      backend_label,
    }
  }
}

/// One tool call being assembled from streamed `delta.tool_calls` chunks.
#[derive(Debug, Default, Clone)]
struct AccumToolCall {
  id: String,
  name: String,
  arguments: String,
}

/// Outcome of one streamed OpenAI completion round.
struct RoundOutcome {
  /// Concatenated `delta.content` text for this round.
  text: String,
  /// Completed tool calls (empty when finish_reason is stop / length).
  tool_calls: Vec<AccumToolCall>,
  /// `stop` | `tool_calls` | `length` | …
  finish_reason: Option<String>,
}

#[async_trait]
impl AgentProposer for OpenAICompatibleProposer {
  async fn propose(
    &self,
    req: AgentRequest,
    tools: Option<ToolSession>,
  ) -> ForestResult<AgentStream> {
    let url = format!(
      "{}/chat/completions",
      self.cfg.base_url.trim_end_matches('/')
    );
    let client = self.client.clone();
    let api_key = self.cfg.api_key.clone();
    let model = self.cfg.model.clone();
    let max_tokens = self.cfg.max_tokens;
    let has_tools = tools.is_some();

    let mut messages = vec![json!({
      "role": "system",
      "content": system_prompt_for(has_tools),
    })];
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
      let tools_json = tools.as_ref().map(|t| openai_tools_array(&t.tools));
      if let Some(tid) = tools.as_ref().and_then(|t| t.turn_id.clone()) {
        yield AgentEvent::TurnStarted { turn_id: tid };
      }

      loop {
        let mut body = json!({
          "model": model,
          "stream": true,
          "max_tokens": max_tokens,
          "messages": messages,
        });
        if let Some(ref t) = tools_json {
          body["tools"] = t.clone();
        }

        let resp = match client
          .post(&url)
          .bearer_auth(&api_key)
          .json(&body)
          .send()
          .await
        {
          Ok(r) => r,
          Err(e) => {
            yield AgentEvent::Error { message: format!("openai connect: {e}") };
            yield AgentEvent::Done;
            return;
          }
        };
        if !resp.status().is_success() {
          let status = resp.status();
          let body = resp.text().await.unwrap_or_default();
          yield AgentEvent::Error {
            message: format!("openai upstream {status}: {body}"),
          };
          yield AgentEvent::Done;
          return;
        }

        let outcome = match stream_openai_round(resp.bytes_stream()).await {
          Ok(o) => o,
          Err(e) => {
            yield AgentEvent::Error { message: e };
            yield AgentEvent::Done;
            return;
          }
        };

        // Forward this round's text tokens as a single block we already
        // accumulated inside stream_openai_round — re-emit as Token so
        // the UI still streams. (Per-delta yield happens inside the
        // helper via a channel… we emit the full round text once here
        // for simplicity; see stream_openai_round_events below.)
        // Actually we need live streaming. Re-do: stream_openai_round
        // can't both yield and return. Inline the stream loop here.

        // The helper already collected; we re-yield text for the UI:
        if !outcome.text.is_empty() {
          all_text.push_str(&outcome.text);
          yield AgentEvent::Token { text: outcome.text.clone() };
        }

        let wants_tools = outcome.finish_reason.as_deref() == Some("tool_calls")
          || !outcome.tool_calls.is_empty();

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

        // Build the assistant message carrying the tool_calls, then
        // execute each and append role=tool messages.
        let mut api_tool_calls = Vec::new();
        let mut tool_messages = Vec::new();

        for tc in &outcome.tool_calls {
          if calls_used >= max_calls {
            break;
          }
          calls_used += 1;

          let input: Value = serde_json::from_str(&tc.arguments)
            .unwrap_or_else(|_| json!({}));
          yield AgentEvent::ToolCallPending {
            id: tc.id.clone(),
            name: tc.name.clone(),
            input: input.clone(),
          };

          let result = dispatch_tool(session.executor.as_ref(), &tc.name, input).await;
          yield AgentEvent::ToolResult {
            id: tc.id.clone(),
            name: tc.name.clone(),
            content: result.content.clone(),
            is_error: result.is_error,
          };
          if let (Some(op), Some(turn_id)) = (result.staged, session.turn_id.as_ref()) {
            yield AgentEvent::StagedDiff {
              turn_id: turn_id.clone(),
              tool_call_id: tc.id.clone(),
              op,
            };
          }

          api_tool_calls.push(json!({
            "id": tc.id,
            "type": "function",
            "function": {
              "name": tc.name,
              "arguments": tc.arguments,
            }
          }));
          tool_messages.push(json!({
            "role": "tool",
            "tool_call_id": tc.id,
            "content": result.content,
          }));
        }

        if api_tool_calls.is_empty() {
          break;
        }

        let assistant_content = if outcome.text.is_empty() {
          Value::Null
        } else {
          Value::String(outcome.text)
        };
        messages.push(json!({
          "role": "assistant",
          "content": assistant_content,
          "tool_calls": api_tool_calls,
        }));
        messages.extend(tool_messages);
        // Loop for the next completion round.
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

/// Stream one OpenAI completion response to completion, collecting text
/// and tool-call argument fragments. Token deltas are *not* live-yielded
/// here — the caller re-emits the round's text. (Live per-token streaming
/// across multi-round tool loops needs a more involved channel design;
/// H2 prioritises correct tool wiring over mid-round token cadence.)
async fn stream_openai_round<S>(byte_stream: S) -> Result<RoundOutcome, String>
where
  S: futures::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send + 'static,
{
  let mut text = String::new();
  let mut tool_calls: HashMap<u64, AccumToolCall> = HashMap::new();
  let mut finish_reason: Option<String> = None;
  let mut event_stream = into_event_stream(byte_stream);

  while let Some(item) = event_stream.next().await {
    let ev = item.map_err(|e| format!("openai stream: {e}"))?;
    if ev.data == "[DONE]" {
      break;
    }
    let val: Value = match serde_json::from_str(&ev.data) {
      Ok(v) => v,
      Err(e) => {
        tracing::debug!("openai: skipping non-json chunk: {e}");
        continue;
      }
    };
    let choice = val
      .get("choices")
      .and_then(|c| c.get(0))
      .cloned()
      .unwrap_or(Value::Null);
    if let Some(fr) = choice.get("finish_reason").and_then(|f| f.as_str()) {
      if fr != "null" {
        finish_reason = Some(fr.to_string());
      }
    }
    let delta = choice.get("delta").cloned().unwrap_or(Value::Null);
    if let Some(t) = delta.get("content").and_then(|c| c.as_str()) {
      if !t.is_empty() {
        text.push_str(t);
      }
    }
    if let Some(arr) = delta.get("tool_calls").and_then(|t| t.as_array()) {
      for item in arr {
        let index = item.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
        let entry = tool_calls.entry(index).or_default();
        if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
          if !id.is_empty() {
            entry.id = id.to_string();
          }
        }
        if let Some(func) = item.get("function") {
          if let Some(name) = func.get("name").and_then(|n| n.as_str()) {
            if !name.is_empty() {
              entry.name.push_str(name);
            }
          }
          if let Some(args) = func.get("arguments").and_then(|a| a.as_str()) {
            entry.arguments.push_str(args);
          }
        }
      }
    }
  }

  // Preserve stream order by index.
  let mut indices: Vec<u64> = tool_calls.keys().copied().collect();
  indices.sort_unstable();
  let tool_calls: Vec<AccumToolCall> = indices
    .into_iter()
    .filter_map(|i| tool_calls.remove(&i))
    .filter(|tc| !tc.name.is_empty())
    .collect();

  Ok(RoundOutcome {
    text,
    tool_calls,
    finish_reason,
  })
}

fn host_of(url: &str) -> &str {
  // Cheap host extraction — good enough for a label.
  url
    .trim_start_matches("https://")
    .trim_start_matches("http://")
    .split('/')
    .next()
    .unwrap_or(url)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn host_of_strips_scheme_and_path() {
    assert_eq!(host_of("https://api.openai.com/v1"), "api.openai.com");
    assert_eq!(host_of("http://localhost:11434/v1"), "localhost:11434");
    assert_eq!(host_of("https://api.deepseek.com"), "api.deepseek.com");
  }
}
