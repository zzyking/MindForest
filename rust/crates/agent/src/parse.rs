//! Pull the structured-proposals JSON block out of an agent's reply.
//!
//! Convention: anywhere in the reply, a fenced code block marked
//! ```mindforest-proposals``` contains a single JSON array of
//! `AgentProposal` values. Anything outside that block is plain prose
//! the user reads as "reasoning". We pick the *last* block in the reply
//! to allow the model to first sketch + then commit (a common pattern in
//! GPT-4 chain-of-thought style replies).
//!
//! When no fenced block is present we return an empty list — the agent
//! produced reasoning but no edits. That's a valid outcome; the UI just
//! shows the prose with no accept/reject affordance.

use crate::AgentProposal;

#[derive(Debug, thiserror::Error)]
pub enum ProposalParseError {
  #[error("proposals block was not valid JSON: {0}")]
  Json(#[from] serde_json::Error),
  #[error("proposals block was JSON but not an array of proposals")]
  NotAnArray,
}

const FENCE: &str = "```mindforest-proposals";

/// Find the last `mindforest-proposals` fenced block and parse it. The
/// fence is recognized at the start of a line (or start of buffer) only;
/// inline backticks in prose don't count.
pub fn extract_proposals(reply: &str) -> Result<Vec<AgentProposal>, ProposalParseError> {
  let Some(start) = find_last_block_start(reply) else {
    return Ok(Vec::new());
  };
  let after_open = match reply[start..].find('\n') {
    Some(nl) => start + nl + 1,
    None => return Ok(Vec::new()),
  };
  let end = match reply[after_open..].find("```") {
    Some(rel) => after_open + rel,
    // Unterminated block — be permissive and parse what we have.
    None => reply.len(),
  };
  let body = reply[after_open..end].trim();
  if body.is_empty() {
    return Ok(Vec::new());
  }
  let val: serde_json::Value = serde_json::from_str(body)?;
  let arr = val.as_array().ok_or(ProposalParseError::NotAnArray)?;
  let mut out = Vec::with_capacity(arr.len());
  for item in arr {
    let p: AgentProposal = serde_json::from_value(item.clone())?;
    out.push(p);
  }
  Ok(out)
}

fn find_last_block_start(reply: &str) -> Option<usize> {
  // Walk from the back, anchoring on line starts.
  let mut last = None;
  let mut cursor = 0;
  while let Some(rel) = reply[cursor..].find(FENCE) {
    let pos = cursor + rel;
    let at_line_start = pos == 0 || reply.as_bytes()[pos - 1] == b'\n';
    if at_line_start {
      last = Some(pos);
    }
    cursor = pos + FENCE.len();
  }
  last
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn empty_input_returns_empty() {
    assert!(extract_proposals("").unwrap().is_empty());
  }

  #[test]
  fn no_block_returns_empty() {
    let txt = "Just some thoughts. Nothing structured here.";
    assert!(extract_proposals(txt).unwrap().is_empty());
  }

  #[test]
  fn single_block_parses() {
    let txt = "Reasoning…\n\n```mindforest-proposals\n[]\n```\n";
    let out = extract_proposals(txt).unwrap();
    assert_eq!(out.len(), 0);
  }

  #[test]
  fn add_node_with_existing_parent() {
    let txt = r#"Reasoning here.

```mindforest-proposals
[
  {
    "op": "add_node",
    "parent": "01HQXR3ZSB3VK6CK60M2ZNGQR0",
    "title": "Backprop",
    "content": "Gradients flow backward.",
    "type": "concept"
  }
]
```"#;
    let out = extract_proposals(txt).unwrap();
    assert_eq!(out.len(), 1);
    match &out[0] {
      AgentProposal::AddNode { title, .. } => assert_eq!(title, "Backprop"),
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn last_block_wins() {
    let txt = "```mindforest-proposals\n[]\n```\n\
               more thinking\n\
               ```mindforest-proposals\n\
               [{\"op\":\"delete_node\",\"id\":\"01HQXR3ZSB3VK6CK60M2ZNGQR0\"}]\n\
               ```\n";
    let out = extract_proposals(txt).unwrap();
    assert_eq!(out.len(), 1);
    matches!(out[0], AgentProposal::DeleteNode { .. });
  }

  #[test]
  fn invalid_json_errors() {
    let txt = "```mindforest-proposals\nnot json\n```";
    let err = extract_proposals(txt).unwrap_err();
    matches!(err, ProposalParseError::Json(_));
  }
}
