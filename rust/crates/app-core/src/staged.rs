//! H3 staged-turn registry — holds shadow journals until accept/reject.

use std::collections::HashMap;
use std::sync::Arc;

use agent::StagedOp;
use domain::{ForestError, ForestResult, NodeId};
use tokio::sync::Mutex;

use crate::shadow::{flush_journal, ShadowForest};
use crate::ForestService;

pub struct StagedTurn {
  pub shadow: Arc<ShadowForest>,
}

pub struct StagedTurnRegistry {
  inner: Mutex<HashMap<String, StagedTurn>>,
}

impl StagedTurnRegistry {
  pub fn new() -> Self {
    Self {
      inner: Mutex::new(HashMap::new()),
    }
  }

  pub fn new_turn_id() -> String {
    NodeId::new().to_string()
  }

  pub async fn insert(&self, turn_id: String, shadow: Arc<ShadowForest>) {
    self
      .inner
      .lock()
      .await
      .insert(turn_id, StagedTurn { shadow });
  }

  pub async fn take(&self, turn_id: &str) -> Option<StagedTurn> {
    self.inner.lock().await.remove(turn_id)
  }
}

impl Default for StagedTurnRegistry {
  fn default() -> Self {
    Self::new()
  }
}

impl ForestService {
  /// Accept a staged turn: flush journal to disk, drop the entry.
  pub async fn accept_staged_turn(&self, turn_id: &str) -> ForestResult<AcceptStagedResponse> {
    let turn = self
      .staged_turns
      .take(turn_id)
      .await
      .ok_or_else(|| ForestError::InvalidInput(format!("unknown staged turn: {turn_id}")))?;
    let journal = turn.shadow.journal_snapshot().await;
    let applied = flush_journal(self, &journal)
      .await
      .map_err(ForestError::Agent)?;
    Ok(AcceptStagedResponse {
      turn_id: turn_id.to_string(),
      applied,
      ops: journal,
    })
  }

  /// Reject a staged turn: discard the shadow journal.
  pub async fn reject_staged_turn(&self, turn_id: &str) -> ForestResult<RejectStagedResponse> {
    let turn = self
      .staged_turns
      .take(turn_id)
      .await
      .ok_or_else(|| ForestError::InvalidInput(format!("unknown staged turn: {turn_id}")))?;
    let discarded = turn.shadow.journal_snapshot().await.len();
    Ok(RejectStagedResponse {
      turn_id: turn_id.to_string(),
      discarded,
    })
  }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AcceptStagedResponse {
  pub turn_id: String,
  pub applied: usize,
  pub ops: Vec<StagedOp>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RejectStagedResponse {
  pub turn_id: String,
  pub discarded: usize,
}
