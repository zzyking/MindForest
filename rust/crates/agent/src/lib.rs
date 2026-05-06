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

/// Provider selector for `AgentConfig`. `Auto` falls through to the
/// same env-var heuristics that `build_proposer_from_env` historically
/// used; the explicit variants pin the backend regardless of env.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentProvider {
  #[default]
  Auto,
  Stub,
  Openai,
  Anthropic,
}

/// User-controlled agent settings. Persisted to disk so the choice
/// survives restarts; mutated through the HTTP `/v1/agent/config`
/// endpoints so the frontend can offer a settings UI.
///
/// Each provider section carries its own credentials + model. Empty /
/// `None` fields fall back to the matching `OPENAI_*` / `ANTHROPIC_*`
/// env vars so a power user who already has a key in their shell
/// environment doesn't have to retype it into the UI.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentConfig {
  pub provider: AgentProvider,
  pub openai: AgentOpenAIConfig,
  pub anthropic: AgentAnthropicConfig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentOpenAIConfig {
  /// e.g. `https://api.openai.com/v1`, `https://api.deepseek.com`,
  /// `http://localhost:11434/v1`. Empty → use the OpenAI default.
  pub base_url: Option<String>,
  /// e.g. `gpt-4o-mini`. Empty → `gpt-4o-mini`.
  pub model: Option<String>,
  /// Empty → fall back to `OPENAI_API_KEY` env at proposer-build time.
  pub api_key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentAnthropicConfig {
  /// e.g. `claude-sonnet-4-6`. Empty → `claude-sonnet-4-6`.
  pub model: Option<String>,
  /// Empty → fall back to `ANTHROPIC_API_KEY` env at proposer-build time.
  pub api_key: Option<String>,
}

/// Construct a proposer from explicit user config, falling back to
/// environment variables for any field the user hasn't overridden.
///
/// The cascade is:
///   1. `config.provider` selects the backend (Auto = env auto-detect)
///   2. each provider's fields use config when set, else env
///   3. if the chosen provider can't find an api_key from either layer,
///      we log and fall back to the stub
pub fn build_proposer_from_config(config: &AgentConfig) -> Arc<dyn AgentProposer> {
  let chosen = match config.provider {
    AgentProvider::Auto => auto_detect(config),
    AgentProvider::Stub => "stub",
    AgentProvider::Openai => "openai",
    AgentProvider::Anthropic => "anthropic",
  };
  match chosen {
    "openai" => match build_openai(&config.openai) {
      Some(p) => Arc::new(p),
      None => {
        tracing::warn!("openai requested but no api_key configured; falling back to stub");
        Arc::new(StubProposer::new())
      }
    },
    "anthropic" => match build_anthropic(&config.anthropic) {
      Some(p) => Arc::new(p),
      None => {
        tracing::warn!("anthropic requested but no api_key configured; falling back to stub");
        Arc::new(StubProposer::new())
      }
    },
    _ => Arc::new(StubProposer::new()),
  }
}

/// Backwards-compatible env-only entry point. Equivalent to
/// `build_proposer_from_config(&AgentConfig::default())`.
pub fn build_proposer_from_env() -> Arc<dyn AgentProposer> {
  build_proposer_from_config(&AgentConfig::default())
}

fn auto_detect(config: &AgentConfig) -> &'static str {
  if config.openai.api_key.is_some() || std::env::var("OPENAI_API_KEY").is_ok() {
    "openai"
  } else if config.anthropic.api_key.is_some() || std::env::var("ANTHROPIC_API_KEY").is_ok() {
    "anthropic"
  } else {
    "stub"
  }
}

fn build_openai(cfg: &AgentOpenAIConfig) -> Option<OpenAICompatibleProposer> {
  let api_key = cfg
    .api_key
    .clone()
    .or_else(|| std::env::var("OPENAI_API_KEY").ok())?;
  let base_url = cfg
    .base_url
    .clone()
    .or_else(|| std::env::var("OPENAI_BASE_URL").ok())
    .unwrap_or_else(|| "https://api.openai.com/v1".into());
  let model = cfg
    .model
    .clone()
    .or_else(|| std::env::var("OPENAI_MODEL").ok())
    .unwrap_or_else(|| "gpt-4o-mini".into());
  Some(OpenAICompatibleProposer::new(OpenAIConfig {
    base_url,
    api_key,
    model,
  }))
}

fn build_anthropic(cfg: &AgentAnthropicConfig) -> Option<AnthropicProposer> {
  let api_key = cfg
    .api_key
    .clone()
    .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())?;
  let model = cfg
    .model
    .clone()
    .or_else(|| std::env::var("ANTHROPIC_MODEL").ok())
    .unwrap_or_else(|| "claude-sonnet-4-6".into());
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
