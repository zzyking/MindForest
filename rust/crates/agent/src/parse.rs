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
//!
//! ## Truncation recovery
//!
//! Long replies often hit the model's `max_tokens` cap mid-string,
//! leaving the JSON array half-written and unparseable. To salvage the
//! useful prefix instead of failing the whole batch, when the strict
//! parse fails we walk objects one at a time from the start of the
//! array, balancing `{}` and string quoting, and parse each closed
//! object individually. The first one that fails to parse stops the
//! salvage — the rest of the buffer is presumed truncated. The user
//! gets the proposals that did make it through plus a note (logged at
//! the call site) that some were dropped, instead of an empty batch.

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
///
/// On strict-parse failure (typically truncation), falls through to a
/// per-object salvage that returns whatever closed-object prefix is
/// well-formed.
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
  match serde_json::from_str::<serde_json::Value>(body) {
    Ok(val) => {
      let arr = val.as_array().ok_or(ProposalParseError::NotAnArray)?;
      let mut out = Vec::with_capacity(arr.len());
      for item in arr {
        let p: AgentProposal = serde_json::from_value(item.clone())?;
        out.push(p);
      }
      Ok(out)
    }
    Err(strict_err) => {
      let salvaged = salvage_objects(body);
      if salvaged.is_empty() {
        // Nothing recoverable — surface the original, more informative
        // strict-mode error so the UI message is useful.
        Err(ProposalParseError::Json(strict_err))
      } else {
        tracing::warn!(
          "proposals block truncated; salvaged {} of N objects (strict parse: {strict_err})",
          salvaged.len()
        );
        Ok(salvaged)
      }
    }
  }
}

/// Walk a possibly-truncated JSON array body and return whatever closed
/// objects we can parse off the front. Stops on the first object that
/// either fails the brace/string scan (truncation) or fails to deserialize
/// into `AgentProposal` (malformed model output).
fn salvage_objects(body: &str) -> Vec<AgentProposal> {
  let bytes = body.as_bytes();
  let mut out = Vec::new();
  let mut i = 0usize;
  // Skip leading whitespace + the opening `[`.
  while i < bytes.len() && bytes[i].is_ascii_whitespace() {
    i += 1;
  }
  if i >= bytes.len() || bytes[i] != b'[' {
    return out;
  }
  i += 1;
  loop {
    while i < bytes.len()
      && (bytes[i].is_ascii_whitespace() || bytes[i] == b',')
    {
      i += 1;
    }
    if i >= bytes.len() || bytes[i] == b']' {
      return out;
    }
    if bytes[i] != b'{' {
      // Unexpected token — bail with what we have.
      return out;
    }
    let Some(end) = scan_object_end(bytes, i) else {
      // Truncation hit mid-object — done salvaging.
      return out;
    };
    let chunk = &body[i..=end];
    match serde_json::from_str::<AgentProposal>(chunk) {
      Ok(p) => out.push(p),
      Err(_) => return out,
    }
    i = end + 1;
  }
}

/// Return the index of the matching closing `}` for the object that
/// starts at `start`, or `None` if the buffer is truncated. Tracks
/// brace depth and respects string quoting + backslash escapes.
fn scan_object_end(bytes: &[u8], start: usize) -> Option<usize> {
  debug_assert_eq!(bytes[start], b'{');
  let mut depth: i32 = 0;
  let mut in_str = false;
  let mut escape = false;
  let mut i = start;
  while i < bytes.len() {
    let b = bytes[i];
    if in_str {
      if escape {
        escape = false;
      } else if b == b'\\' {
        escape = true;
      } else if b == b'"' {
        in_str = false;
      }
    } else {
      match b {
        b'"' => in_str = true,
        b'{' => depth += 1,
        b'}' => {
          depth -= 1;
          if depth == 0 {
            return Some(i);
          }
        }
        _ => {}
      }
    }
    i += 1;
  }
  None
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

  #[test]
  fn salvages_truncated_array() {
    // Two complete objects followed by a truncated third — exactly the
    // shape we see when the model hits max_tokens mid-content.
    let txt = "```mindforest-proposals\n[\n\
      {\"op\":\"add_node\",\"parent\":\"01HQXR3ZSB3VK6CK60M2ZNGQR0\",\"title\":\"A\",\"content\":\"alpha\",\"type\":\"concept\"},\n\
      {\"op\":\"add_node\",\"parent\":\"01HQXR3ZSB3VK6CK60M2ZNGQR0\",\"title\":\"B\",\"content\":\"beta\",\"type\":\"concept\"},\n\
      {\"op\":\"add_node\",\"parent\":\"01HQXR3ZSB3VK6CK60M2ZNGQR0\",\"title\":\"C\",\"content\":\"gam";
    let out = extract_proposals(txt).unwrap();
    assert_eq!(out.len(), 2, "should salvage the two closed objects");
    if let AgentProposal::AddNode { title, .. } = &out[0] {
      assert_eq!(title, "A");
    } else {
      panic!("wrong variant");
    }
  }

  #[test]
  fn salvage_handles_braces_inside_strings() {
    // A `}` inside a quoted string would break a naive depth counter.
    let txt = "```mindforest-proposals\n[\n\
      {\"op\":\"add_node\",\"parent\":\"01HQXR3ZSB3VK6CK60M2ZNGQR0\",\"title\":\"A\",\"content\":\"closing brace } here\",\"type\":\"concept\"},\n\
      {\"op\":\"add_node\",\"parent\":\"01HQXR3ZSB3VK6CK60M2ZNGQR0\",\"title\":\"B\",\"content\":\"trunc";
    let out = extract_proposals(txt).unwrap();
    assert_eq!(out.len(), 1);
  }
}
