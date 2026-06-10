//! Agent surface on `ForestService` — proposal dispatch and runtime
//! config swaps.
//!
//! This is where the harness work (H1..H3) lands: the `ContextBuilder`
//! call will slot into `propose()` before dispatch, and staged-turn
//! accept/reject will live alongside `set_agent_config`. See
//! `AGENT_HARNESS.md`.

use agent::{secret_accounts, AgentConfig, AgentRequest, AgentStream};
use domain::{ForestError, ForestResult, NodeId, TopicId};

use crate::config::write_agent_config_file;
use crate::ForestService;

impl ForestService {
  /// Build the agent context (full topic + node list) and dispatch.
  /// The returned stream is alive for the duration of one HTTP SSE
  /// response; the route handler maps each `AgentEvent` to a frame.
  pub async fn propose(
    &self,
    topic_id: &TopicId,
    focused_node_id: Option<NodeId>,
    prompt: String,
    history: Vec<agent::AgentTurn>,
  ) -> ForestResult<AgentStream> {
    let topic = self.repo.get_topic(topic_id).await?;
    let nodes = self.repo.list_nodes_in_topic(topic_id).await?;
    // H1: locate the focus inside the wider vault (spine + cross-topic
    // neighbors). Best-effort — a None here just means the model works
    // from the node dump alone, as it did before the harness.
    let vault_context = self
      .build_vault_context(&topic, &nodes, focused_node_id)
      .await;
    let req = AgentRequest {
      topic,
      nodes,
      focused_node_id,
      prompt,
      history,
      vault_context,
    };
    let proposer = self.proposer.read().await.clone();
    proposer.propose(req).await
  }

  /// Backend label, e.g. `"stub"`, `"gpt-4o-mini (api.openai.com)"`,
  /// `"claude-sonnet-4-6 (anthropic)"`. Surfaced via the agent status
  /// endpoint so the UI can render a "powered by …" hint.
  pub async fn agent_backend(&self) -> String {
    self.proposer.read().await.backend().to_string()
  }

  /// Snapshot of the persisted agent configuration, with API keys
  /// included verbatim. The HTTP route exposes this on loopback only;
  /// callers outside the service should not relay it elsewhere.
  pub async fn agent_config(&self) -> AgentConfig {
    self.agent_config.read().await.clone()
  }

  /// Persist a new `AgentConfig` and rebuild the proposer. Returns the
  /// new backend label so the caller (HTTP route) can echo it back to
  /// the UI without a second round-trip.
  ///
  /// API keys are written through to the `SecretStore` (OS keychain).
  /// The serialized `agent.json` does not contain plaintext keys —
  /// `AgentOpenAIConfig::api_key` and friends are `skip_serializing`.
  /// An empty/None key clears the keychain entry, matching the user's
  /// intent ("revoke this provider's key").
  pub async fn set_agent_config(&self, config: AgentConfig) -> ForestResult<String> {
    // Secrets first. Doing this before the file write means a keychain
    // failure surfaces as a hard error rather than a half-applied state
    // where the file says one provider but the keychain says another.
    self.write_secret(secret_accounts::OPENAI, config.openai.api_key.as_deref())?;
    self.write_secret(
      secret_accounts::ANTHROPIC,
      config.anthropic.api_key.as_deref(),
    )?;
    if let Some(path) = self.agent_config_path.as_ref() {
      write_agent_config_file(path, &config)
        .await
        .map_err(ForestError::Storage)?;
    }
    let new_proposer = agent::build_proposer_from_config(&config);
    let backend = new_proposer.backend().to_string();
    *self.proposer.write().await = new_proposer;
    *self.agent_config.write().await = config;
    Ok(backend)
  }

  /// `Some("non-empty")` writes the secret; `None` or `Some("")` deletes
  /// it. Errors map onto `ForestError::Storage` so the route handler
  /// returns a clean 500 with the underlying reason.
  fn write_secret(&self, account: &str, value: Option<&str>) -> ForestResult<()> {
    match value {
      Some(v) if !v.is_empty() => self
        .secret_store
        .set(account, v)
        .map_err(|e| ForestError::Storage(format!("keychain set {account}: {e}"))),
      _ => self
        .secret_store
        .delete(account)
        .map_err(|e| ForestError::Storage(format!("keychain delete {account}: {e}"))),
    }
  }
}
