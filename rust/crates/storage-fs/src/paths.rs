//! Vault path resolution and filename conventions.

use std::path::{Path, PathBuf};

use domain::{NodeId, TopicId};

pub(crate) const TOPIC_FILE: &str = "_topic.md";

pub(crate) fn topic_dir(vault: &Path, id: &TopicId) -> PathBuf {
  vault.join(id.as_str())
}

pub(crate) fn topic_file(vault: &Path, id: &TopicId) -> PathBuf {
  topic_dir(vault, id).join(TOPIC_FILE)
}

/// Build a `<slug>--<ulid>.md` filename for a brand-new node.
pub(crate) fn new_node_filename(title: &str, id: &NodeId) -> String {
  let slug = slugify(title);
  if slug.is_empty() {
    format!("untitled--{id}.md")
  } else {
    format!("{slug}--{id}.md")
  }
}

/// Extract the trailing ULID from a node filename like `slug--01HV6Q....md`.
pub(crate) fn id_from_filename(name: &str) -> Option<NodeId> {
  let stem = name.strip_suffix(".md")?;
  let ulid_part = stem.rsplit_once("--").map(|(_, b)| b).unwrap_or(stem);
  ulid_part.parse().ok()
}

/// ASCII-only slugifier: lowercase letters/digits, `-` separators, no
/// leading/trailing dashes. Non-ASCII chars are dropped (CJK titles will
/// produce empty slugs and fall back to `untitled`).
pub(crate) fn slugify(title: &str) -> String {
  let mut out = String::with_capacity(title.len());
  let mut needs_dash = false;
  for c in title.chars() {
    if c.is_ascii_alphanumeric() {
      if needs_dash && !out.is_empty() {
        out.push('-');
      }
      out.push(c.to_ascii_lowercase());
      needs_dash = false;
    } else {
      needs_dash = true;
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn slugify_handles_common_cases() {
    assert_eq!(slugify("Backpropagation"), "backpropagation");
    assert_eq!(slugify("Chain rule of calculus"), "chain-rule-of-calculus");
    assert_eq!(slugify("Eigenvalues & Eigenvectors"), "eigenvalues-eigenvectors");
    assert_eq!(slugify("  spaces  around  "), "spaces-around");
    assert_eq!(slugify("multi---dash"), "multi-dash");
    assert_eq!(slugify("中文"), "");
    assert_eq!(slugify("中文 mixed 123"), "mixed-123");
  }

  #[test]
  fn id_from_filename_extracts_ulid() {
    let id = NodeId::new();
    let name = format!("backprop--{id}.md");
    assert_eq!(id_from_filename(&name), Some(id));

    // No slug prefix, just `<ulid>.md` — also works.
    let bare = format!("{id}.md");
    assert_eq!(id_from_filename(&bare), Some(id));

    assert_eq!(id_from_filename("not-md"), None);
    assert_eq!(id_from_filename("garbage--xx.md"), None);
  }
}
