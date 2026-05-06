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

use async_trait::async_trait;
use domain::{ForestError, ForestResult};
use futures::StreamExt;
use serde_json::json;

use crate::prompt::{build_user_message, SYSTEM_PROMPT};
use crate::sse::into_event_stream;
use crate::{extract_proposals, AgentEvent, AgentProposer, AgentRequest, AgentStream};

#[derive(Debug, Clone)]
pub struct OpenAIConfig {
  /// e.g. `https://api.openai.com/v1`, `https://api.deepseek.com/v1`,
  /// `http://localhost:11434/v1` (Ollama). Trailing slash optional.
  pub base_url: String,
  pub api_key: String,
  pub model: String,
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

#[async_trait]
impl AgentProposer for OpenAICompatibleProposer {
  async fn propose(&self, req: AgentRequest) -> ForestResult<AgentStream> {
    let url = format!("{}/chat/completions", self.cfg.base_url.trim_end_matches('/'));
    let body = json!({
      "model": self.cfg.model,
      "stream": true,
      "messages": [
        { "role": "system", "content": SYSTEM_PROMPT },
        { "role": "user", "content": build_user_message(&req) },
      ],
    });
    let resp = self
      .client
      .post(&url)
      .bearer_auth(&self.cfg.api_key)
      .json(&body)
      .send()
      .await
      .map_err(|e| ForestError::Agent(format!("openai connect: {e}")))?;
    if !resp.status().is_success() {
      let status = resp.status();
      let body = resp.text().await.unwrap_or_default();
      return Err(ForestError::Agent(format!(
        "openai upstream {status}: {body}"
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
            yield AgentEvent::Error { message: format!("openai stream: {e}") };
            break;
          }
        };
        if ev.data == "[DONE]" {
          break;
        }
        let val: serde_json::Value = match serde_json::from_str(&ev.data) {
          Ok(v) => v,
          Err(e) => {
            tracing::debug!("openai: skipping non-json chunk: {e}");
            continue;
          }
        };
        // `choices[0].delta.content` is the only field we use. Tool
        // calls + function calls + finish_reason are ignored — proposals
        // come out of the prose buffer at end-of-stream instead.
        if let Some(text) = val
          .get("choices")
          .and_then(|c| c.get(0))
          .and_then(|c| c.get("delta"))
          .and_then(|d| d.get("content"))
          .and_then(|c| c.as_str())
        {
          if !text.is_empty() {
            buf.push_str(text);
            yield AgentEvent::Token { text: text.to_string() };
          }
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
