//! H1 of the agent harness — structural context injection
//! (`AGENT_HARNESS.md` §L1).
//!
//! Builds the `<vault-context>` block that locates the focused node
//! inside the wider vault before every propose turn. The propose
//! request already carries the focused topic's full node list, so the
//! genuinely *new* signal here is everything that list can't show:
//!
//! - the focus spine made explicit (ancestors / siblings / children) so
//!   the model doesn't have to re-derive structure from parent pointers,
//! - the focus node's outgoing links, resolved even when they point
//!   into other topics,
//! - `<semantic-neighbors>` — embedding hits from OTHER topics, the
//!   only channel through which the rest of the vault is visible at all.
//!
//! XML-ish, not prose: providers parse the structure cleanly and the
//! closing tags stop the "model completes an unclosed block" failure
//! mode. The whole block is best-effort — every fallible step degrades
//! to a smaller block rather than failing the turn.
//!
//! `<recent-edits>` from the design doc is not built yet: it needs a
//! vault-wide mtime scan that `ForestRepository` doesn't expose, and it
//! is also the second thing the doc's drop-order discards — its absence
//! only makes the block smaller.

use std::collections::{HashMap, HashSet};

use domain::{Node, NodeId, NodeType, Topic, TopicId};

use crate::ForestService;

/// Hard ceiling on the rendered block, in estimated tokens. Override
/// with `MINDFOREST_AGENT_CONTEXT_BUDGET`.
const DEFAULT_BUDGET_TOKENS: usize = 2000;

/// Over-fetch from the index so same-topic / already-linked hits can be
/// filtered out without starving the final list.
const NEIGHBOR_FETCH_K: usize = 12;
const NEIGHBOR_KEEP: usize = 5;

/// Minimum cosine similarity for a node to count as a semantic neighbor.
/// Below this the match is too weak to spend the model's attention on,
/// and — because EmbeddingGemma-300M sits any two English passages around
/// a ~0.58 baseline — junk / near-empty nodes would otherwise slip in and
/// dominate a sparse vault's cross-topic pool. Override with
/// `MINDFOREST_AGENT_NEIGHBOR_MIN_COSINE`.
///
/// Calibrated on this model against the focused "Tokenization" node:
/// genuinely related cross-topic nodes (subword/BPE) scored ~0.69,
/// loosely related (text-feature preprocessing) ~0.64, a stub-draft junk
/// node ~0.58, and unrelated content (image CNNs, logistics) below that.
/// 0.60 keeps the first two tiers and drops the generic-baseline noise.
const DEFAULT_NEIGHBOR_MIN_COSINE: f32 = 0.60;

/// Walking parent pointers must terminate even on a corrupted vault
/// where the files encode a cycle.
const MAX_ANCESTOR_DEPTH: usize = 32;

impl ForestService {
  /// Build the `<vault-context>` block for one propose turn. `None`
  /// only when the focus can't be resolved at all (e.g. deleted between
  /// the route reading the topic and this call).
  pub(crate) async fn build_vault_context(
    &self,
    topic: &Topic,
    nodes: &[Node],
    focused_node_id: Option<NodeId>,
  ) -> Option<String> {
    let focus_id = focused_node_id.unwrap_or(topic.root_node_id);
    let by_id: HashMap<NodeId, &Node> = nodes.iter().map(|n| (n.id, n)).collect();
    let focus = by_id.get(&focus_id).copied()?;

    // Spine: root-first so the chain reads top-down like a breadcrumb.
    let mut ancestors: Vec<&Node> = Vec::new();
    let mut cursor = focus.parent;
    while let Some(pid) = cursor {
      let Some(parent) = by_id.get(&pid).copied() else { break };
      ancestors.push(parent);
      cursor = parent.parent;
      if ancestors.len() >= MAX_ANCESTOR_DEPTH {
        break;
      }
    }
    ancestors.reverse();

    let siblings: Vec<&Node> = match focus.parent {
      Some(pid) => nodes
        .iter()
        .filter(|n| n.parent == Some(pid) && n.id != focus_id)
        .collect(),
      None => Vec::new(),
    };
    let children: Vec<&Node> = nodes.iter().filter(|n| n.parent == Some(focus_id)).collect();

    // Outgoing links: in-topic ids resolve from the list we already
    // have; cross-topic ids go through the repository. A dangling link
    // is silently skipped — broken references are a vault-repair
    // concern, not a propose-turn concern.
    let mut links: Vec<(Option<String>, NodeType, String, NodeId)> = Vec::new();
    for link_id in &focus.links {
      if let Some(n) = by_id.get(link_id) {
        links.push((None, n.node_type, n.title.clone(), n.id));
      } else if let Ok(n) = self.repo.read_node(link_id).await {
        links.push((Some(n.topic.as_str().to_owned()), n.node_type, n.title, n.id));
      }
    }

    // Semantic neighbors — the cross-topic channel. Same-topic hits are
    // excluded because the request body already carries this topic in
    // full; explicit links are excluded because they render above.
    let linked: HashSet<NodeId> = focus.links.iter().copied().collect();
    let query = format!("{} {}", focus.title, excerpt(&focus.content, 200));
    let neighbors = self
      .semantic_neighbors(&query, focus_id, &topic.id, &linked)
      .await;

    // ── Render sections ──────────────────────────────────────────────
    let focus_sec = format!(
      "  <focus topic=\"{}\" id=\"{}\" type=\"{}\" title=\"{}\">\n    {}\n  </focus>\n",
      esc(topic.id.as_str()),
      focus.id,
      type_str(&focus.node_type),
      esc(&focus.title),
      esc(&excerpt(&focus.content, 200)),
    );
    let ancestors_sec = render_list(
      "ancestors",
      ancestors.iter().map(|n| {
        format!(
          "    <node id=\"{}\" type=\"{}\" title=\"{}\" summary=\"{}\" />\n",
          n.id,
          type_str(&n.node_type),
          esc(&n.title),
          esc(&excerpt(&n.content, 120)),
        )
      }),
    );
    let siblings_sec = render_title_only("siblings", &siblings);
    let children_sec = render_title_only("children", &children);
    let links_sec = render_list(
      "links",
      links.iter().map(|(topic, node_type, title, id)| {
        let topic_attr = topic
          .as_deref()
          .map(|t| format!(" topic=\"{}\"", esc(t)))
          .unwrap_or_default();
        format!(
          "    <node id=\"{id}\"{topic_attr} type=\"{}\" title=\"{}\" />\n",
          type_str(node_type),
          esc(title),
        )
      }),
    );
    let neighbors_sec = render_list(
      "semantic-neighbors",
      neighbors.iter().map(|h| {
        format!(
          "    <node id=\"{}\" topic=\"{}\" title=\"{}\" score=\"{:.2}\" />\n",
          h.id,
          esc(h.topic.as_str()),
          esc(&h.title),
          h.score,
        )
      }),
    );

    // ── Assemble under budget ────────────────────────────────────────
    // Drop ladder per the design doc: neighbors go first, then links,
    // then the sibling/children lists get capped; the focus + ancestor
    // spine is never touched. The final rung ships regardless — an
    // over-budget spine beats no orientation at all.
    let budget = context_budget();
    let assemble = |with_neighbors: bool, with_links: bool, list_cap: Option<usize>| {
      let mut out = String::from("<vault-context>\n");
      out.push_str(&focus_sec);
      out.push_str(&ancestors_sec);
      match list_cap {
        None => {
          out.push_str(&siblings_sec);
          out.push_str(&children_sec);
        }
        Some(cap) => {
          out.push_str(&render_title_only_capped("siblings", &siblings, cap));
          out.push_str(&render_title_only_capped("children", &children, cap));
        }
      }
      if with_links {
        out.push_str(&links_sec);
      }
      if with_neighbors {
        out.push_str(&neighbors_sec);
      }
      out.push_str("</vault-context>");
      out
    };
    let ladder = [
      assemble(true, true, None),
      assemble(false, true, None),
      assemble(false, false, None),
      assemble(false, false, Some(8)),
    ];
    let block = ladder
      .iter()
      .find(|b| estimate_tokens(b) <= budget)
      .unwrap_or(&ladder[ladder.len() - 1])
      .clone();
    Some(block)
  }

  /// Cross-topic semantic neighbors for the focus — embedding-only, with
  /// a hard cosine floor.
  ///
  /// Deliberately NOT the RRF-fused `search`: fusion mixes in lexical FTS
  /// hits and reports a rank-based score that says nothing about
  /// relevance, so it can't be thresholded. Pure vector search returns
  /// cosine similarity, and a floor drops weak/junk matches — a
  /// near-empty node embeds to a spurious vector that fuzzily "matches"
  /// everything at low similarity, exactly the noise we don't want the
  /// model chasing. When the embedder is unavailable the section is
  /// simply empty: no neighbors beats lexical noise dressed up as
  /// "semantic".
  async fn semantic_neighbors(
    &self,
    query: &str,
    focus_id: NodeId,
    topic_id: &TopicId,
    linked: &HashSet<NodeId>,
  ) -> Vec<domain::SearchHit> {
    if !self.embedder.available() {
      return Vec::new();
    }
    let mut embedded = match self.embedder.embed(std::slice::from_ref(&query.to_owned())).await {
      Ok(v) => v,
      Err(e) => {
        tracing::warn!("vault-context: neighbor embed failed, omitting the section: {e}");
        return Vec::new();
      }
    };
    let Some(q_vec) = embedded.pop() else {
      return Vec::new();
    };
    let floor = neighbor_min_cosine();
    match self.index.search_vec(&q_vec, None, NEIGHBOR_FETCH_K).await {
      Ok(hits) => hits
        .into_iter()
        .filter(|h| {
          h.id != focus_id
            && &h.topic != topic_id
            && !linked.contains(&h.id)
            && h.score >= floor
        })
        .take(NEIGHBOR_KEEP)
        .collect(),
      Err(e) => {
        // Not routine — semantic search quietly returning nothing is the
        // "it silently broke" class of bug (see search.rs module docs).
        tracing::error!("vault-context: neighbor vec search failed, omitting the section: {e}");
        Vec::new()
      }
    }
  }
}

fn render_list(tag: &str, entries: impl Iterator<Item = String>) -> String {
  let body: String = entries.collect();
  if body.is_empty() {
    return String::new();
  }
  format!("  <{tag}>\n{body}  </{tag}>\n")
}

fn render_title_only(tag: &str, nodes: &[&Node]) -> String {
  render_title_only_capped(tag, nodes, usize::MAX)
}

fn render_title_only_capped(tag: &str, nodes: &[&Node], cap: usize) -> String {
  let omitted = nodes.len().saturating_sub(cap);
  let mut body = render_list(
    tag,
    nodes.iter().take(cap).map(|n| {
      format!(
        "    <node id=\"{}\" type=\"{}\" title=\"{}\" />\n",
        n.id,
        type_str(&n.node_type),
        esc(&n.title),
      )
    }),
  );
  if omitted > 0 && !body.is_empty() {
    body = body.replace(
      &format!("  </{tag}>"),
      &format!("    <omitted count=\"{omitted}\" />\n  </{tag}>"),
    );
  }
  body
}

/// First `n` chars, ellipsised. Newlines flattened so the value sits
/// cleanly inside one XML text node / attribute.
fn excerpt(s: &str, n: usize) -> String {
  let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
  let mut out: String = flat.chars().take(n).collect();
  if flat.chars().count() > n {
    out.push('…');
  }
  out
}

fn esc(s: &str) -> String {
  s.replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
    .replace('"', "&quot;")
}

/// Wire-format name of a node type, via serde — deliberately NOT
/// another exhaustive match (the taxonomy already touches seven files
/// per new variant; this must not become an eighth).
fn type_str(t: &NodeType) -> String {
  serde_json::to_value(t)
    .ok()
    .and_then(|v| v.as_str().map(str::to_owned))
    .unwrap_or_default()
}

/// Coarse token estimate: ASCII ≈ 4 chars/token, everything else
/// (mostly CJK in this vault) ≈ 1 token/char. Errs toward
/// over-counting, which is the safe direction for a hard budget.
fn estimate_tokens(s: &str) -> usize {
  let (ascii, other) = s
    .chars()
    .fold((0usize, 0usize), |(a, o), c| if c.is_ascii() { (a + 1, o) } else { (a, o + 1) });
  ascii / 4 + other
}

fn context_budget() -> usize {
  std::env::var("MINDFOREST_AGENT_CONTEXT_BUDGET")
    .ok()
    .and_then(|v| v.parse().ok())
    .unwrap_or(DEFAULT_BUDGET_TOKENS)
}

fn neighbor_min_cosine() -> f32 {
  std::env::var("MINDFOREST_AGENT_NEIGHBOR_MIN_COSINE")
    .ok()
    .and_then(|v| v.parse().ok())
    .unwrap_or(DEFAULT_NEIGHBOR_MIN_COSINE)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn excerpt_flattens_and_caps() {
    assert_eq!(excerpt("a\nb  c", 10), "a b c");
    assert_eq!(excerpt("abcdef", 3), "abc…");
  }

  #[test]
  fn esc_covers_xml_metachars() {
    assert_eq!(esc(r#"<a & "b">"#), "&lt;a &amp; &quot;b&quot;&gt;");
  }

  #[test]
  fn token_estimate_weights_cjk_per_char() {
    // 8 ASCII chars → 2; 4 CJK chars → 4.
    assert_eq!(estimate_tokens("abcdefgh"), 2);
    assert_eq!(estimate_tokens("知识森林"), 4);
  }
}
