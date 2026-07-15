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
pub mod secrets;
mod sse;
mod stub;
mod tools;

pub use anthropic::{AnthropicConfig, AnthropicProposer};
pub use openai::{OpenAICompatibleProposer, OpenAIConfig};
pub use parse::{extract_proposals, ProposalParseError};
pub use secrets::{mask_secret, InMemoryStore, KeyringStore, SecretError, SecretStore};
pub use stub::StubProposer;
pub use tools::{
  read_only_tools, AgentToolCall, ReadNodeInput, SearchInput, ToolDef, ToolExecutor, ToolResult,
  DEFAULT_SEARCH_K, MF_READ_NODE, MF_SEARCH,
};

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
///
/// ## Where the api_key lives
///
/// In memory the `api_key` field on each provider sub-struct is the
/// authoritative current secret used by `build_proposer_from_config`.
/// On disk only the non-secret fields persist (`#[serde(skip_serializing)]`
/// on `api_key`). The composition layer (`app-core::bootstrap`) reads
/// the secret from a `SecretStore` (OS Keychain) and injects it into
/// the in-memory struct at load time. Legacy plaintext keys still in
/// `agent.json` from older builds deserialize successfully and get
/// migrated into the SecretStore on first load.
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
  /// `skip_serializing` keeps this out of `agent.json`; the value lives
  /// in the SecretStore (OS keychain) and is injected at load time.
  /// Deserialize is still wired up so legacy plaintext entries from
  /// pre-keychain installs are detected and migrated.
  #[serde(skip_serializing, default)]
  pub api_key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentAnthropicConfig {
  /// e.g. `claude-sonnet-4-6`. Empty → `claude-sonnet-4-6`.
  pub model: Option<String>,
  /// Empty → fall back to `ANTHROPIC_API_KEY` env at proposer-build time.
  /// See `AgentOpenAIConfig::api_key` for the storage rationale.
  #[serde(skip_serializing, default)]
  pub api_key: Option<String>,
}

/// SecretStore "account" identifiers — one row per provider.
pub mod secret_accounts {
  pub const OPENAI: &str = "openai";
  pub const ANTHROPIC: &str = "anthropic";
}

/// SecretStore "service" identifier used across the codebase. Reverse-DNS
/// form because it surfaces in the user's OS credential UI.
pub const SECRET_SERVICE: &str = "com.mindforest.agent";

// ─────────────────────────────────────────────────────────────────────
// HTTP wire types
//
// `AgentConfigView` / `AgentConfigUpdate` are deliberately separate from
// `AgentConfig`. The frontend gets a masked view (no plaintext secrets
// over the wire even on loopback) and submits a triple-state update
// (omit = keep, null = clear, string = set) so editing a non-secret
// field doesn't accidentally erase the keychain entry.
// ─────────────────────────────────────────────────────────────────────

/// Read view returned by `GET /v1/agent/config`. Same shape as
/// `AgentConfig` minus plaintext `api_key`s: each provider section
/// exposes `api_key_set` + `api_key_hint` (e.g. `"sk-…1234"`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfigView {
  pub provider: AgentProvider,
  pub openai: AgentOpenAIConfigView,
  pub anthropic: AgentAnthropicConfigView,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentOpenAIConfigView {
  pub base_url: Option<String>,
  pub model: Option<String>,
  pub api_key_set: bool,
  pub api_key_hint: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentAnthropicConfigView {
  pub model: Option<String>,
  pub api_key_set: bool,
  pub api_key_hint: Option<String>,
}

impl From<&AgentConfig> for AgentConfigView {
  fn from(c: &AgentConfig) -> Self {
    let openai_key = c.openai.api_key.as_deref().unwrap_or("");
    let anthropic_key = c.anthropic.api_key.as_deref().unwrap_or("");
    Self {
      provider: c.provider,
      openai: AgentOpenAIConfigView {
        base_url: c.openai.base_url.clone(),
        model: c.openai.model.clone(),
        api_key_set: !openai_key.is_empty(),
        api_key_hint: secrets::mask_secret(openai_key),
      },
      anthropic: AgentAnthropicConfigView {
        model: c.anthropic.model.clone(),
        api_key_set: !anthropic_key.is_empty(),
        api_key_hint: secrets::mask_secret(anthropic_key),
      },
    }
  }
}

/// Write payload for `PUT /v1/agent/config`. provider / base_url / model
/// are whole-value replacements (the frontend always sends them).
/// `api_key` is **triple-state** — the JSON encoding distinguishes:
///
/// - field omitted from the request → `None` → keep the current key
/// - field is JSON `null` → `Some(None)` → clear the key (delete from keychain)
/// - field is a JSON string → `Some(Some(s))` → replace with `s`
///
/// This matters because the settings UI lets the user tweak `base_url`
/// or `model` without re-entering the secret; without the triple state
/// the server would have to choose between "always require api_key" or
/// "treat missing key as clear", both of which are footguns.
#[derive(Debug, Deserialize)]
pub struct AgentConfigUpdate {
  pub provider: AgentProvider,
  pub openai: AgentOpenAIConfigUpdate,
  pub anthropic: AgentAnthropicConfigUpdate,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct AgentOpenAIConfigUpdate {
  pub base_url: Option<String>,
  pub model: Option<String>,
  #[serde(default, deserialize_with = "deserialize_optional_field")]
  pub api_key: Option<Option<String>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct AgentAnthropicConfigUpdate {
  pub model: Option<String>,
  #[serde(default, deserialize_with = "deserialize_optional_field")]
  pub api_key: Option<Option<String>>,
}

/// "Double-option" deserializer. serde's `default` skips this function
/// entirely when the field is missing, yielding the outer `None`. When
/// the field is present (including `null`), serde calls in here and we
/// wrap the inner `Option<T>` in `Some(...)`. Together that gives us
/// the three states described on `AgentConfigUpdate`.
fn deserialize_optional_field<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
  T: serde::Deserialize<'de>,
  D: serde::Deserializer<'de>,
{
  serde::Deserialize::deserialize(deserializer).map(Some)
}

/// Apply an `AgentConfigUpdate` to a current `AgentConfig`, returning
/// the merged result. Triple-state `api_key` fields collapse against
/// the current values; non-secret fields are overwritten.
pub fn merge_config_update(current: &AgentConfig, update: AgentConfigUpdate) -> AgentConfig {
  let mut next = current.clone();
  next.provider = update.provider;
  next.openai.base_url = update.openai.base_url;
  next.openai.model = update.openai.model;
  next.openai.api_key = match update.openai.api_key {
    None => current.openai.api_key.clone(), // keep
    Some(None) => None,                     // clear
    Some(Some(s)) if s.is_empty() => None,  // empty string also clears, matches UI "type then delete"
    Some(Some(s)) => Some(s),               // set
  };
  next.anthropic.model = update.anthropic.model;
  next.anthropic.api_key = match update.anthropic.api_key {
    None => current.anthropic.api_key.clone(),
    Some(None) => None,
    Some(Some(s)) if s.is_empty() => None,
    Some(Some(s)) => Some(s),
  };
  next
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
  Some(OpenAICompatibleProposer::new(OpenAIConfig::new(
    base_url, api_key, model,
  )))
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
  /// Earlier turns in the same conversation, oldest first. Empty for
  /// a fresh chat. The current `prompt` is the *next* user message; we
  /// don't repeat it inside `history`.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub history: Vec<AgentTurn>,
  /// Pre-rendered `<vault-context>` block locating the focus inside the
  /// wider vault — focus spine, resolved links, cross-topic semantic
  /// neighbors. Built by app-core's context builder (harness H1, see
  /// `AGENT_HARNESS.md` §L1); `None` when the focus couldn't be
  /// resolved. Prepended to the user message by `build_user_message`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub vault_context: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentRole {
  User,
  Assistant,
}

/// One turn in the prior conversation. We carry plain text rather than
/// structured events because the persisted assistant turn is the model's
/// raw reply (prose preamble + the fenced JSON block) and replaying that
/// verbatim keeps the model's stylistic memory intact.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurn {
  pub role: AgentRole,
  pub text: String,
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

#[cfg(test)]
mod tests {
  use super::*;

  fn current_with_keys() -> AgentConfig {
    let mut c = AgentConfig::default();
    c.provider = AgentProvider::Openai;
    c.openai.model = Some("gpt-4o-mini".into());
    c.openai.api_key = Some("sk-openai-existing".into());
    c.anthropic.api_key = Some("sk-ant-existing".into());
    c
  }

  #[test]
  fn view_masks_keys_and_reports_set_flag() {
    let v = AgentConfigView::from(&current_with_keys());
    assert!(v.openai.api_key_set);
    assert_eq!(v.openai.api_key_hint.as_deref(), Some("sk-…ting"));
    assert!(v.anthropic.api_key_set);
    let none = AgentConfig::default();
    let v2 = AgentConfigView::from(&none);
    assert!(!v2.openai.api_key_set);
    assert_eq!(v2.openai.api_key_hint, None);
  }

  #[test]
  fn update_omitted_api_key_keeps_current() {
    let body = serde_json::json!({
      "provider": "openai",
      "openai": { "base_url": null, "model": "gpt-4o" },
      "anthropic": { "model": null }
    });
    let upd: AgentConfigUpdate = serde_json::from_value(body).unwrap();
    let merged = merge_config_update(&current_with_keys(), upd);
    assert_eq!(merged.openai.api_key.as_deref(), Some("sk-openai-existing"));
    assert_eq!(merged.openai.model.as_deref(), Some("gpt-4o"));
    assert_eq!(merged.anthropic.api_key.as_deref(), Some("sk-ant-existing"));
  }

  #[test]
  fn update_null_api_key_clears() {
    let body = serde_json::json!({
      "provider": "openai",
      "openai": { "api_key": null },
      "anthropic": {}
    });
    let upd: AgentConfigUpdate = serde_json::from_value(body).unwrap();
    let merged = merge_config_update(&current_with_keys(), upd);
    assert_eq!(merged.openai.api_key, None);
    // unaffected
    assert_eq!(merged.anthropic.api_key.as_deref(), Some("sk-ant-existing"));
  }

  #[test]
  fn update_string_api_key_sets() {
    let body = serde_json::json!({
      "provider": "anthropic",
      "openai": {},
      "anthropic": { "api_key": "sk-ant-new" }
    });
    let upd: AgentConfigUpdate = serde_json::from_value(body).unwrap();
    let merged = merge_config_update(&current_with_keys(), upd);
    assert_eq!(merged.anthropic.api_key.as_deref(), Some("sk-ant-new"));
    assert_eq!(merged.provider, AgentProvider::Anthropic);
  }

  #[test]
  fn update_empty_string_api_key_clears() {
    let body = serde_json::json!({
      "provider": "openai",
      "openai": { "api_key": "" },
      "anthropic": {}
    });
    let upd: AgentConfigUpdate = serde_json::from_value(body).unwrap();
    let merged = merge_config_update(&current_with_keys(), upd);
    assert_eq!(merged.openai.api_key, None);
  }
}
