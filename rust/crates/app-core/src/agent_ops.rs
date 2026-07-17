//! Agent surface on `ForestService` — proposal dispatch and runtime
//! config swaps.
//!
//! H1: `ContextBuilder` into every propose.
//! H2: read tools.
//! H3: full tool session against a per-turn `ShadowForest`; accept/reject
//! live in `staged.rs`.

use std::sync::Arc;

use agent::{secret_accounts, AgentConfig, AgentRequest, AgentStream, ToolSession};
use domain::{ForestError, ForestResult, NodeId, TopicId};

use crate::config::write_agent_config_file;
use crate::shadow::ShadowForest;
use crate::staged::StagedTurnRegistry;
use crate::ForestService;

impl ForestService {
  /// Build the agent context and dispatch with a full (H3) tool session
  /// bound to a fresh shadow journal. The stream emits `turn_started`
  /// then tool/staged-diff events; the journal stays registered until
  /// accept/reject.
  pub async fn propose(
    &self,
    topic_id: &TopicId,
    focused_node_id: Option<NodeId>,
    prompt: String,
    history: Vec<agent::AgentTurn>,
  ) -> ForestResult<AgentStream> {
    let topic = self.repo.get_topic(topic_id).await?;
    let nodes = self.repo.list_nodes_in_topic(topic_id).await?;
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

    let turn_id = StagedTurnRegistry::new_turn_id();
    let shadow = Arc::new(ShadowForest::new(Arc::new(self.clone())));
    self
      .staged_turns
      .insert(turn_id.clone(), shadow.clone())
      .await;
    let tools = Some(ToolSession::full(shadow, turn_id));

    let proposer = self.proposer.read().await.clone();
    proposer.propose(req, tools).await
  }

  pub async fn agent_backend(&self) -> String {
    self.proposer.read().await.backend().to_string()
  }

  pub async fn agent_config(&self) -> AgentConfig {
    self.agent_config.read().await.clone()
  }

  pub async fn set_agent_config(&self, config: AgentConfig) -> ForestResult<String> {
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
