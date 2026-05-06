//! `agent` — provider-agnostic LLM agent layer.
//!
//! Exposes a single `AgentProposer` trait whose `propose()` returns an
//! async stream of `AgentEvent`s. The HTTP layer (`apps/api`) bridges
//! that stream into Server-Sent Events the frontend renders incrementally.
//!
//! Concrete backends:
//!
//! - **`StubProposer`** — emits a canned token stream + proposal. No
//!   network. Used in tests and as the default when no provider is
//!   configured (so the rest of the system is exercised end-to-end).
//!
//! - **`OpenAICompatibleProposer`** — talks the OpenAI
//!   `/v1/chat/completions` streaming protocol. The same code targets
//!   OpenAI proper, DeepSeek, Groq, Together, vLLM, and Ollama (via
//!   `http://localhost:11434/v1`) — pick the backend by setting
//!   `OPENAI_BASE_URL` + `OPENAI_MODEL` + `OPENAI_API_KEY`.
//!
//! - **`AnthropicProposer`** — talks Claude's `/v1/messages` SSE shape.
//!   Selected via `MINDFOREST_AGENT_PROVIDER=anthropic` +
//!   `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL`.
//!
//! ## Output protocol
//!
//! The agent is asked (via system prompt) to return free-form prose
//! followed by a single fenced JSON block delimited by
//! `mindforest-proposals` containing an array of `AgentProposal` values.
//! Provider impls stream raw text deltas as `AgentEvent::Token`, then
//! at end-of-stream parse the trailing block into `AgentProposal`s and
//! emit them as `AgentEvent::Proposal` before the final
//! `AgentEvent::Done`. Parse failures surface as a single
//! `AgentEvent::Error` followed by `Done` so the client can close
//! cleanly.

use std::pin::Pin;

use async_trait::async_trait;
use domain::{ForestResult, Node, NodeId, NodeType, Topic};
use futures::Stream;
use serde::{Deserialize, Serialize};

mod anthropic;
mod openai;
mod parse;
mod prompt;
mod sse;
mod stub;

pub use anthropic::{AnthropicConfig, AnthropicProposer};
pub use openai::{OpenAICompatibleProposer, OpenAIConfig};
pub use parse::{extract_proposals, ProposalParseError};
pub use stub::StubProposer;

use std::sync::Arc;

/// Construct a proposer from environment variables.
///
/// `MINDFOREST_AGENT_PROVIDER` selects the backend:
/// - `stub` (default when unset *and* no API keys are present)
/// - `openai` — requires `OPENAI_API_KEY`. Honors `OPENAI_BASE_URL`
///   (default `https://api.openai.com/v1`) and `OPENAI_MODEL`
///   (default `gpt-4o-mini`). Same code path covers any
///   OpenAI-compatible endpoint (DeepSeek, Groq, Ollama, …).
/// - `anthropic` — requires `ANTHROPIC_API_KEY`. Honors
///   `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`).
///
/// When the variable is unset we auto-detect: if `OPENAI_API_KEY` is
/// present we pick OpenAI; else if `ANTHROPIC_API_KEY` is present we
/// pick Anthropic; else we fall back to the stub. This means a clean
/// dev install "just works" with the stub, but any user who exports a
/// key gets the real provider without further config.
pub fn build_proposer_from_env() -> Arc<dyn AgentProposer> {
  let explicit = std::env::var("MINDFOREST_AGENT_PROVIDER").ok();
  let chosen = match explicit.as_deref() {
    Some("stub") => "stub",
    Some("openai") => "openai",
    Some("anthropic") => "anthropic",
    Some(other) => {
      tracing::warn!("unknown MINDFOREST_AGENT_PROVIDER={other:?}, using auto-detect");
      auto_detect()
    }
    None => auto_detect(),
  };
  match chosen {
    "openai" => match build_openai_from_env() {
      Some(p) => Arc::new(p),
      None => {
        tracing::warn!("openai requested but OPENAI_API_KEY missing; falling back to stub");
        Arc::new(StubProposer::new())
      }
    },
    "anthropic" => match build_anthropic_from_env() {
      Some(p) => Arc::new(p),
      None => {
        tracing::warn!("anthropic requested but ANTHROPIC_API_KEY missing; falling back to stub");
        Arc::new(StubProposer::new())
      }
    },
    _ => Arc::new(StubProposer::new()),
  }
}

fn auto_detect() -> &'static str {
  if std::env::var("OPENAI_API_KEY").is_ok() {
    "openai"
  } else if std::env::var("ANTHROPIC_API_KEY").is_ok() {
    "anthropic"
  } else {
    "stub"
  }
}

fn build_openai_from_env() -> Option<OpenAICompatibleProposer> {
  let api_key = std::env::var("OPENAI_API_KEY").ok()?;
  let base_url =
    std::env::var("OPENAI_BASE_URL").unwrap_or_else(|_| "https://api.openai.com/v1".into());
  let model = std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o-mini".into());
  Some(OpenAICompatibleProposer::new(OpenAIConfig {
    base_url,
    api_key,
    model,
  }))
}

fn build_anthropic_from_env() -> Option<AnthropicProposer> {
  let api_key = std::env::var("ANTHROPIC_API_KEY").ok()?;
  let model = std::env::var("ANTHROPIC_MODEL").unwrap_or_else(|_| "claude-sonnet-4-6".into());
  Some(AnthropicProposer::new(AnthropicConfig::new(api_key, model)))
}

/// One event in the agent's reply stream.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvent {
  /// Raw text delta — append to the user-visible draft.
  Token { text: String },
  /// A structured edit the agent suggests.
  Proposal { proposal: AgentProposal },
  /// Non-fatal note (e.g. "couldn't parse proposals block"). Stream
  /// still continues; the client just surfaces the message.
  Error { message: String },
  /// Stream is over; safe to close the SSE connection.
  Done,
}

/// A single structured edit. The frontend renders these as a draft the
/// user can accept/reject. `client_id` is generated by the agent so that
/// later proposals in the same batch can refer to a yet-to-be-applied
/// node (e.g. add_node A, then add_node B with parent=A).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum AgentProposal {
  AddNode {
    /// Stable handle the agent assigns so it can reference this new
    /// node in later proposals before the client applies it. The client
    /// resolves it to a real `NodeId` when applying.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
    parent: NodeRef,
    title: String,
    #[serde(default)]
    content: String,
    #[serde(default, rename = "type")]
    node_type: NodeType,
  },
  UpdateNode {
    id: NodeId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "type")]
    node_type: Option<NodeType>,
  },
  DeleteNode {
    id: NodeId,
  },
  Link {
    from: NodeRef,
    to: NodeRef,
  },
  Unlink {
    from: NodeId,
    to: NodeId,
  },
}

/// Reference to a node — either an existing real `NodeId`, or a
/// `client_id` placeholder that points at an `AddNode` earlier in the
/// same proposal batch. Serialized as a plain string; the discriminator
/// is "is this 26-char ULID?" — anything else is a client_id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeRef {
  Existing(NodeId),
  New(String),
}

impl Serialize for NodeRef {
  fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
    match self {
      NodeRef::Existing(id) => id.to_string().serialize(ser),
      NodeRef::New(s) => s.serialize(ser),
    }
  }
}

impl<'de> Deserialize<'de> for NodeRef {
  fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
    let s = String::deserialize(de)?;
    Ok(match s.parse::<NodeId>() {
      Ok(id) => NodeRef::Existing(id),
      Err(_) => NodeRef::New(s),
    })
  }
}

/// What the caller hands the agent. The full topic + node list goes in
/// because we don't yet do retrieval — small forests are cheap to
/// serialize and pasting them whole is the simplest correct context.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRequest {
  pub topic: Topic,
  pub nodes: Vec<Node>,
  /// The node the user has open — the agent should treat it as the
  /// implicit subject when the prompt is ambiguous.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub focused_node_id: Option<NodeId>,
  pub prompt: String,
}

/// Boxed stream alias so the trait method signature stays readable.
pub type AgentStream = Pin<Box<dyn Stream<Item = AgentEvent> + Send>>;

/// The interface the rest of the system codes against. Implementations
/// own their own HTTP client + auth state.
#[async_trait]
pub trait AgentProposer: Send + Sync {
  /// Start a propose session. Errors only on synchronous setup failures
  /// (bad config); transport errors that happen mid-stream surface as
  /// `AgentEvent::Error` followed by `AgentEvent::Done`.
  async fn propose(&self, req: AgentRequest) -> ForestResult<AgentStream>;

  /// Human-readable backend name, surfaced to clients via
  /// `GET /v1/agent/status` so the UI can show "powered by …".
  fn backend(&self) -> &str;
}
