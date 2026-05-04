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

/// Filesystem-safe Unicode slugifier.
///
/// - Keeps any Unicode alphanumeric (`is_alphanumeric` — letters in any script
///   incl. CJK, plus digits) and `_` `-` `.`.
/// - Replaces every other char (whitespace, `/\:*?<>|"`, punctuation, control,
///   etc.) with `-`, collapsing runs.
/// - Lowercases ASCII; non-ASCII letters pass through unchanged
///   (CJK has no case; we don't transliterate, the user should see their
///   own script in filenames).
/// - Trims leading/trailing `-` and `.` so we never create dotfiles or
///   trailing-separator names.
/// - Caps at 200 UTF-8 bytes, truncating at a char boundary, with room
///   to spare for the `--<ulid>.md` suffix (31 bytes) within typical
///   filesystem limits (255 bytes).
///
/// Returns `""` for inputs that contain no keepable chars; callers fall
/// back to a stable filler like `untitled`.
pub(crate) fn slugify(title: &str) -> String {
  const MAX_LEN: usize = 200;

  let mut out = String::with_capacity(title.len());
  let mut prev_dash = false;
  for c in title.chars() {
    let keepable = c.is_alphanumeric() || c == '_' || c == '-' || c == '.';
    if keepable {
      // Collapse consecutive `-` (no-op for other kept chars).
      if c == '-' && prev_dash {
        continue;
      }
      for lc in c.to_lowercase() {
        out.push(lc);
      }
      prev_dash = c == '-';
    } else if !prev_dash && !out.is_empty() {
      out.push('-');
      prev_dash = true;
    }
  }

  let trimmed: String = out
    .trim_matches(|c: char| c == '-' || c == '.')
    .to_string();

  if trimmed.len() <= MAX_LEN {
    return trimmed;
  }
  let mut cutoff = MAX_LEN;
  while !trimmed.is_char_boundary(cutoff) {
    cutoff -= 1;
  }
  trimmed[..cutoff].trim_end_matches(['-', '.']).to_string()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn slugify_ascii_basics() {
    assert_eq!(slugify("Backpropagation"), "backpropagation");
    assert_eq!(slugify("Chain rule of calculus"), "chain-rule-of-calculus");
    assert_eq!(slugify("Eigenvalues & Eigenvectors"), "eigenvalues-eigenvectors");
    assert_eq!(slugify("  spaces  around  "), "spaces-around");
    assert_eq!(slugify("multi---dash"), "multi-dash");
    assert_eq!(slugify("Question?"), "question");
    assert_eq!(slugify("Hello/World"), "hello-world");
  }

  #[test]
  fn slugify_preserves_unicode_letters() {
    assert_eq!(slugify("数学"), "数学");
    assert_eq!(slugify("中文 mixed 123"), "中文-mixed-123");
    assert_eq!(slugify("数学 与 物理"), "数学-与-物理");
    assert_eq!(slugify("Café Résumé"), "café-résumé");
    assert_eq!(slugify("日本語タイトル"), "日本語タイトル");
    assert_eq!(slugify("한글 제목"), "한글-제목");
  }

  #[test]
  fn slugify_strips_edge_dots_and_dashes() {
    assert_eq!(slugify(".dotfile"), "dotfile");
    assert_eq!(slugify("trailing-"), "trailing");
    assert_eq!(slugify("--leading"), "leading");
    assert_eq!(slugify("..."), "");
    assert_eq!(slugify(""), "");
    assert_eq!(slugify("   "), "");
  }

  #[test]
  fn slugify_caps_length_at_char_boundary() {
    let long_ascii = "a".repeat(300);
    assert_eq!(slugify(&long_ascii).len(), 200);

    // CJK char is 3 UTF-8 bytes; 100 of them = 300 bytes, should cap.
    let long_cjk: String = "中".repeat(100);
    let slug = slugify(&long_cjk);
    assert!(slug.len() <= 200);
    // No partial CJK byte sequences:
    assert!(slug.is_char_boundary(slug.len()));
    // Should consist of full `中` chars only.
    assert!(slug.chars().all(|c| c == '中'));
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
