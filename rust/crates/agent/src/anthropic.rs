//! Anthropic `/v1/messages` provider.
//!
//! ## Streaming
//!
//! With `"stream": true` Anthropic emits named SSE events. We only need
//! `content_block_delta` (one per token chunk); other events
//! (`message_start`, `ping`, `message_delta`, `message_stop`) are
//! ignored. The chunk shape is a `content_block_delta` event whose
//! data carries `{"delta":{"type":"text_delta","text":"…"}}`. Same
//! accumulator pattern as the OpenAI side: stream tokens, then parse
//! proposals out of the buffered prose at the end.

use async_trait::async_trait;
use domain::{ForestError, ForestResult};
use futures::StreamExt;
use serde_json::json;

use crate::prompt::{build_user_message, SYSTEM_PROMPT};
use crate::sse::into_event_stream;
use crate::{extract_proposals, AgentEvent, AgentProposer, AgentRequest, AgentRole, AgentStream};

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

#[async_trait]
impl AgentProposer for AnthropicProposer {
  async fn propose(&self, req: AgentRequest) -> ForestResult<AgentStream> {
    let url = format!("{}/messages", self.cfg.base_url.trim_end_matches('/'));
    let mut messages: Vec<serde_json::Value> = Vec::with_capacity(req.history.len() + 1);
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
    let body = json!({
      "model": self.cfg.model,
      "max_tokens": self.cfg.max_tokens,
      "stream": true,
      "system": SYSTEM_PROMPT,
      "messages": messages,
    });
    let resp = self
      .client
      .post(&url)
      .header("x-api-key", &self.cfg.api_key)
      .header("anthropic-version", ANTHROPIC_VERSION)
      .json(&body)
      .send()
      .await
      .map_err(|e| ForestError::Agent(format!("anthropic connect: {e}")))?;
    if !resp.status().is_success() {
      let status = resp.status();
      let body = resp.text().await.unwrap_or_default();
      return Err(ForestError::Agent(format!(
        "anthropic upstream {status}: {body}"
      )));
    }

    let byte_stream = resp.bytes_stream();
    let event_stream = into_event_stream(byte_stream);

    Ok(Box::pin(async_stream::stream! {
      let mut buf = String::new();
      let mut s = event_stream;
      while let Some(item) = s.next().await {
        let ev = match item {
          Ok(e) => e,
          Err(e) => {
            yield AgentEvent::Error { message: format!("anthropic stream: {e}") };
            break;
          }
        };
        match ev.event.as_deref() {
          Some("content_block_delta") => {
            let val: serde_json::Value = match serde_json::from_str(&ev.data) {
              Ok(v) => v,
              Err(_) => continue,
            };
            // Only text_delta carries user-visible content; other delta
            // types (input_json_delta for tool args, etc.) are ignored
            // because we don't ask the model to use tools.
            if let Some(text) = val
              .get("delta")
              .and_then(|d| d.get("text"))
              .and_then(|t| t.as_str())
            {
              if !text.is_empty() {
                buf.push_str(text);
                yield AgentEvent::Token { text: text.to_string() };
              }
            }
          }
          Some("message_stop") => break,
          Some("error") => {
            yield AgentEvent::Error { message: format!("anthropic error event: {}", ev.data) };
            break;
          }
          // Ignore message_start, ping, content_block_start/stop,
          // message_delta — they don't change buffered text.
          _ => {}
        }
      }
      match extract_proposals(&buf) {
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
