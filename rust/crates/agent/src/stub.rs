//! Deterministic, no-network proposer for tests + dev fallback.
//!
//! Emits a few token chunks of canned reasoning and then a single
//! `add_node` proposal under the focused node. Useful as the default
//! when no real provider is configured so the rest of the system —
//! SSE plumbing, frontend overlay, accept/reject flow — can be
//! exercised without an API key or a network round-trip.

use async_trait::async_trait;
use domain::{ForestResult, NodeType};
use futures::stream;

use crate::{AgentEvent, AgentProposal, AgentProposer, AgentRequest, AgentStream, NodeRef};

#[derive(Default, Clone)]
pub struct StubProposer;

impl StubProposer {
  pub fn new() -> Self {
    Self
  }
}

#[async_trait]
impl AgentProposer for StubProposer {
  async fn propose(&self, req: AgentRequest) -> ForestResult<AgentStream> {
    // Pick a parent: the focused node, or the topic root if no focus.
    let parent_id = req.focused_node_id.unwrap_or(req.topic.root_node_id);

    let prose = format!(
      "I read the prompt: {:?}. Here's a stubbed suggestion — adding a child note under the focused node.",
      req.prompt
    );
    // Chunk on whitespace so the client gets multiple Token events.
    let mut events: Vec<AgentEvent> = prose
      .split_inclusive(' ')
      .map(|s| AgentEvent::Token { text: s.to_string() })
      .collect();
    events.push(AgentEvent::Token {
      text: "\n\n(structured proposal follows)".into(),
    });
    events.push(AgentEvent::Proposal {
      proposal: AgentProposal::AddNode {
        client_id: Some("stub-1".into()),
        parent: NodeRef::Existing(parent_id),
        title: format!("Re: {}", truncate(&req.prompt, 40)),
        content: "_Stub-generated draft. Replace the agent provider to get real output._".into(),
        node_type: NodeType::Misc,
      },
    });
    events.push(AgentEvent::Done);
    Ok(Box::pin(stream::iter(events)))
  }

  fn backend(&self) -> &str {
    "stub"
  }
}

fn truncate(s: &str, n: usize) -> String {
  if s.chars().count() <= n {
    return s.to_string();
  }
  let mut out: String = s.chars().take(n).collect();
  out.push('…');
  out
}

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::Utc;
  use domain::{NodeId, Topic, TopicId};
  use futures::StreamExt;

  fn topic_fixture() -> AgentRequest {
    let now = Utc::now();
    let root = NodeId::new();
    AgentRequest {
      topic: Topic {
        id: TopicId::new("test").unwrap(),
        title: "Test".into(),
        root_node_id: root,
        bulletin: String::new(),
        created_at: now,
        updated_at: now,
      },
      nodes: vec![],
      focused_node_id: None,
      prompt: "say something interesting".into(),
    }
  }

  #[tokio::test]
  async fn stub_emits_tokens_then_proposal_then_done() {
    let p = StubProposer::new();
    let mut s = p.propose(topic_fixture()).await.unwrap();
    let mut tokens = 0;
    let mut proposals = 0;
    let mut done = false;
    while let Some(ev) = s.next().await {
      match ev {
        AgentEvent::Token { .. } => tokens += 1,
        AgentEvent::Proposal { .. } => proposals += 1,
        AgentEvent::Done => {
          done = true;
          break;
        }
        AgentEvent::Error { .. } => panic!("unexpected error"),
      }
    }
    assert!(tokens > 0);
    assert_eq!(proposals, 1);
    assert!(done);
  }
}
