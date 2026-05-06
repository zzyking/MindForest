//! System prompt + context builder shared by all providers.
//!
//! The system prompt is identical across OpenAI / Anthropic / future
//! backends — they're all instruction-following chat models in the end.
//! Putting it here keeps the per-provider files focused on transport.
//!
//! The user message is the JSON-encoded `AgentRequest` followed by the
//! free-form prompt. We keep the topic + nodes intact in the message
//! body rather than splitting into a separate "context" turn — single
//! turn is simpler and the model picks up structured context fine.

use serde_json::json;

use crate::AgentRequest;

pub const SYSTEM_PROMPT: &str = r#"You are the MindForest authoring agent.

MindForest is a personal knowledge tool. The user's notes are organized as a tree of *nodes* that may also be cross-linked into a graph. Each node has:
- id: ULID (26 chars)
- parent: id of parent node, or null for the topic root
- type: one of concept | fact | source | example | question | task | misc
- title: short headline
- content: longer markdown body
- links: zero or more node ids this node is graph-linked to

You will receive a JSON document describing the current topic and all nodes, along with the id of the node the user has open ("focused"), and the user's prompt.

Your reply has TWO parts:

1. A short prose explanation of what you understood and what you propose. Keep it tight — 2–4 sentences. Refer to existing nodes by their title in this prose.

2. A single fenced code block containing a JSON array of structured proposals. The fence label MUST be `mindforest-proposals`. Each proposal is an object with an `op` field. Supported ops:

  - {"op":"add_node","parent":"<id-or-client_id>","title":"…","content":"…","type":"concept","client_id":"a1"}
    `client_id` is optional; provide one if a later proposal in this batch needs to reference this new node as a parent or link target.
  - {"op":"update_node","id":"<existing-id>","title":"…","content":"…","type":"…"}
    Omit fields you don't want to change.
  - {"op":"delete_node","id":"<existing-id>"}
  - {"op":"link","from":"<id-or-client_id>","to":"<id-or-client_id>"}
  - {"op":"unlink","from":"<existing-id>","to":"<existing-id>"}

Rules:
- Always output the fenced block, even if the array is empty.
- Use existing node ids verbatim — don't make them up. New nodes use `client_id` placeholders.
- Be conservative. Prefer one focused suggestion to a sprawling rewrite.
- Don't output anything after the closing fence."#;

/// Render the user-side message that carries context + prompt.
pub fn build_user_message(req: &AgentRequest) -> String {
  let context = json!({
    "topic": {
      "id": req.topic.id.as_str(),
      "title": req.topic.title,
      "root_node_id": req.topic.root_node_id.to_string(),
    },
    "focused_node_id": req.focused_node_id.map(|id| id.to_string()),
    "nodes": req.nodes.iter().map(|n| json!({
      "id": n.id.to_string(),
      "parent": n.parent.map(|p| p.to_string()),
      "type": n.node_type,
      "title": n.title,
      "content": n.content,
      "links": n.links.iter().map(|l| l.to_string()).collect::<Vec<_>>(),
    })).collect::<Vec<_>>(),
  });
  format!(
    "Here is the current MindForest state:\n\n{}\n\nUser prompt:\n{}",
    serde_json::to_string_pretty(&context).unwrap_or_else(|_| context.to_string()),
    req.prompt,
  )
}
