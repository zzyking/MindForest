//! `index-sqlite` — derived SQLite index over the vault.
//!
//! The vault (markdown files) is the source of truth; this crate maintains
//! a fully derivable cache of it for fast queries:
//!
//! - `nodes`     — flat metadata (id, topic, parent, type, title, timestamps,
//!                  content_hash). Indexed by topic + parent for O(1) tree walks.
//! - `links`     — directed edge list, both directions stored as separate rows.
//! - `nodes_fts` — FTS5 virtual table over (title, content) for keyword search.
//! - `embed_jobs`— work queue for the Phase 3 embedding pipeline.
//! - `meta`      — kv (schema_version, last_full_scan).
//!
//! Phase 1 ships only FTS5; `search_vec` returns `EmbedUnavailable` until
//! sqlite-vec and the MLX sidecar land in Phase 3.

use std::path::PathBuf;

use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use rusqlite::params;
use tokio_rusqlite::Connection;

use domain::{
  ForestError, ForestRepository, ForestResult, IndexStatus, Indexer, Node, NodeId, NodeType,
  SearchHit, TopicId,
};

const SCHEMA_VERSION: i64 = 1;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS nodes (
    id           TEXT PRIMARY KEY,
    topic        TEXT NOT NULL,
    parent       TEXT,
    type         TEXT NOT NULL,
    title        TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_topic  ON nodes(topic);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent);

CREATE TABLE IF NOT EXISTS links (
    src_id TEXT NOT NULL,
    dst_id TEXT NOT NULL,
    PRIMARY KEY (src_id, dst_id)
);
CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst_id);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    id UNINDEXED, title, content,
    tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS embed_jobs (
    id           TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    status       TEXT NOT NULL,
    error        TEXT
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

#[derive(Clone)]
pub struct SqliteIndex {
  conn: Connection,
}

impl SqliteIndex {
  /// Open (creating if missing) the index database at `path`.
  /// Parent directory is created if it doesn't exist.
  pub async fn open(path: impl Into<PathBuf>) -> ForestResult<Self> {
    let path = path.into();
    if let Some(parent) = path.parent() {
      tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| ForestError::Index(format!("create_dir {parent:?}: {e}")))?;
    }
    let conn = Connection::open(&path)
      .await
      .map_err(|e| ForestError::Index(format!("open {path:?}: {e}")))?;
    let me = Self { conn };
    me.ensure_schema().await?;
    Ok(me)
  }

  /// Open an in-memory index — useful for tests and ephemeral setups.
  pub async fn open_in_memory() -> ForestResult<Self> {
    let conn = Connection::open(":memory:")
      .await
      .map_err(|e| ForestError::Index(format!("open in-memory: {e}")))?;
    let me = Self { conn };
    me.ensure_schema().await?;
    Ok(me)
  }

  async fn ensure_schema(&self) -> ForestResult<()> {
    self
      .conn
      .call(|conn| {
        conn.execute_batch(SCHEMA_SQL)?;
        conn.execute(
          "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?1)",
          params![SCHEMA_VERSION.to_string()],
        )?;
        Ok(())
      })
      .await
      .map_err(|e| ForestError::Index(format!("init schema: {e}")))
  }
}

#[async_trait]
impl Indexer for SqliteIndex {
  async fn upsert(&self, node: &Node) -> ForestResult<()> {
    let id = node.id.to_string();
    let topic = node.topic.as_str().to_string();
    let parent = node.parent.map(|p| p.to_string());
    let node_type = node_type_to_str(node.node_type).to_string();
    let title = node.title.clone();
    let content = node.content.clone();
    let created_ms = node.created_at.timestamp_millis();
    let updated_ms = node.updated_at.timestamp_millis();
    let content_hash = blake3::hash(content.as_bytes()).to_hex().to_string();
    let links: Vec<String> = node.links.iter().map(|l| l.to_string()).collect();

    self
      .conn
      .call(move |conn| {
        let tx = conn.transaction()?;
        tx.execute(
          "INSERT INTO nodes
             (id, topic, parent, type, title, created_at, updated_at, content_hash)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT(id) DO UPDATE SET
             topic        = excluded.topic,
             parent       = excluded.parent,
             type         = excluded.type,
             title        = excluded.title,
             updated_at   = excluded.updated_at,
             content_hash = excluded.content_hash",
          params![
            id, topic, parent, node_type, title, created_ms, updated_ms, content_hash
          ],
        )?;

        // FTS5 has no ON CONFLICT; delete-then-insert.
        tx.execute("DELETE FROM nodes_fts WHERE id = ?1", params![id])?;
        tx.execute(
          "INSERT INTO nodes_fts (id, title, content) VALUES (?1, ?2, ?3)",
          params![id, title, content],
        )?;

        // Replace outgoing links wholesale; cheaper than diffing.
        tx.execute("DELETE FROM links WHERE src_id = ?1", params![id])?;
        for link in &links {
          tx.execute(
            "INSERT OR IGNORE INTO links (src_id, dst_id) VALUES (?1, ?2)",
            params![id, link],
          )?;
        }

        tx.commit()?;
        Ok(())
      })
      .await
      .map_err(|e| ForestError::Index(format!("upsert: {e}")))
  }

  async fn delete(&self, id: &NodeId) -> ForestResult<()> {
    let id_str = id.to_string();
    self
      .conn
      .call(move |conn| {
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM nodes WHERE id = ?1", params![id_str])?;
        tx.execute("DELETE FROM nodes_fts WHERE id = ?1", params![id_str])?;
        tx.execute(
          "DELETE FROM links WHERE src_id = ?1 OR dst_id = ?1",
          params![id_str],
        )?;
        tx.execute("DELETE FROM embed_jobs WHERE id = ?1", params![id_str])?;
        tx.commit()?;
        Ok(())
      })
      .await
      .map_err(|e| ForestError::Index(format!("delete: {e}")))
  }

  async fn search_fts(
    &self,
    query: &str,
    topic: Option<&TopicId>,
    k: usize,
  ) -> ForestResult<Vec<SearchHit>> {
    let sanitized = build_fts_query(query);
    if sanitized.is_empty() {
      return Ok(Vec::new());
    }
    let topic_str = topic.map(|t| t.as_str().to_string());
    let k = k as i64;

    // Column index `-1` in snippet() asks FTS5 to return the snippet from
    // whichever indexed column the match was actually in (title or content),
    // which is what users expect for highlighted previews.
    let rows: Vec<(String, String, String, String, f64)> = self
      .conn
      .call(move |conn| {
        let rows = match topic_str {
          Some(t) => {
            let mut stmt = conn.prepare(
              "SELECT n.id, n.topic, n.title,
                      snippet(nodes_fts, -1, '<b>', '</b>', '…', 12) AS snip,
                      bm25(nodes_fts) AS score
                 FROM nodes_fts
                 JOIN nodes n ON n.id = nodes_fts.id
                WHERE nodes_fts MATCH ?1 AND n.topic = ?2
                ORDER BY score
                LIMIT ?3",
            )?;
            let iter = stmt.query_map(params![sanitized, t, k], row_to_tuple)?;
            iter.collect::<Result<Vec<_>, _>>()?
          }
          None => {
            let mut stmt = conn.prepare(
              "SELECT n.id, n.topic, n.title,
                      snippet(nodes_fts, -1, '<b>', '</b>', '…', 12) AS snip,
                      bm25(nodes_fts) AS score
                 FROM nodes_fts
                 JOIN nodes n ON n.id = nodes_fts.id
                WHERE nodes_fts MATCH ?1
                ORDER BY score
                LIMIT ?2",
            )?;
            let iter = stmt.query_map(params![sanitized, k], row_to_tuple)?;
            iter.collect::<Result<Vec<_>, _>>()?
          }
        };
        Ok(rows)
      })
      .await
      .map_err(|e| ForestError::Index(format!("search_fts: {e}")))?;

    let mut hits = Vec::with_capacity(rows.len());
    for (id_s, topic_s, title, snippet, bm25_score) in rows {
      let id: NodeId = id_s.parse()?;
      let topic = TopicId::new(topic_s)?;
      hits.push(SearchHit {
        id,
        topic,
        title,
        snippet,
        // bm25 returns more-negative-is-better; flip so callers can
        // treat higher = better consistently with vec search.
        score: -bm25_score as f32,
      });
    }
    Ok(hits)
  }

  async fn search_vec(
    &self,
    _embedding: &[f32],
    _topic: Option<&TopicId>,
    _k: usize,
  ) -> ForestResult<Vec<SearchHit>> {
    // Phase 3 will load sqlite-vec and wire EmbeddingGemma via the MLX
    // sidecar. Until then the Embedder reports unavailable; consumers
    // (app-core) degrade hybrid search to FTS-only.
    Err(ForestError::EmbedUnavailable)
  }

  async fn status(&self) -> ForestResult<IndexStatus> {
    let (pending, last_scan_ms) = self
      .conn
      .call(|conn| {
        let pending: i64 = conn
          .query_row(
            "SELECT COUNT(*) FROM embed_jobs WHERE status = 'pending'",
            [],
            |r| r.get(0),
          )
          .unwrap_or(0);
        let last_scan_ms: Option<i64> = conn
          .query_row(
            "SELECT value FROM meta WHERE key = 'last_full_scan'",
            [],
            |r| {
              let s: String = r.get(0)?;
              Ok(s.parse::<i64>().ok())
            },
          )
          .unwrap_or(None);
        Ok((pending, last_scan_ms))
      })
      .await
      .map_err(|e| ForestError::Index(format!("status: {e}")))?;

    let last_scan = last_scan_ms.and_then(|ms| Utc.timestamp_millis_opt(ms).single());
    Ok(IndexStatus {
      embed_pending: pending as usize,
      fts_dirty: false,
      last_scan,
      embed_available: false,
    })
  }

  async fn rebuild_from(&self, repo: &dyn ForestRepository) -> ForestResult<()> {
    self
      .conn
      .call(|conn| {
        let tx = conn.transaction()?;
        tx.execute_batch(
          "DELETE FROM nodes;
           DELETE FROM nodes_fts;
           DELETE FROM links;
           DELETE FROM embed_jobs;",
        )?;
        tx.commit()?;
        Ok(())
      })
      .await
      .map_err(|e| ForestError::Index(format!("rebuild clear: {e}")))?;

    let topics = repo.list_topics().await?;
    for topic in topics {
      let nodes = repo.list_nodes_in_topic(&topic.id).await?;
      for node in nodes {
        self.upsert(&node).await?;
      }
    }

    let now_ms = Utc::now().timestamp_millis();
    self
      .conn
      .call(move |conn| {
        conn.execute(
          "INSERT OR REPLACE INTO meta (key, value) VALUES ('last_full_scan', ?1)",
          params![now_ms.to_string()],
        )?;
        Ok(())
      })
      .await
      .map_err(|e| ForestError::Index(format!("update last_scan: {e}")))?;

    Ok(())
  }
}

fn row_to_tuple(
  row: &rusqlite::Row,
) -> rusqlite::Result<(String, String, String, String, f64)> {
  Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
}

fn node_type_to_str(t: NodeType) -> &'static str {
  match t {
    NodeType::Concept => "concept",
    NodeType::Fact => "fact",
    NodeType::Source => "source",
    NodeType::Example => "example",
    NodeType::Question => "question",
    NodeType::Task => "task",
    NodeType::Misc => "misc",
  }
}

/// Build a safe FTS5 MATCH query from free-text user input.
///
/// Tokenizes the input respecting double-quoted phrases. Each whitespace-
/// separated bare word becomes a quoted FTS5 term; double-quoted spans
/// become FTS5 phrase queries (preserving internal whitespace so token
/// adjacency is required). All resulting tokens are implicitly AND'd
/// (FTS5's default).
///
/// Examples:
///
/// | input                     | output                          | semantics                |
/// |---------------------------|---------------------------------|--------------------------|
/// | `cat dog`                 | `"cat" "dog"`                   | both must appear         |
/// | `"deep learning"`         | `"deep learning"`               | adjacency required       |
/// | `cat "deep learning"`     | `"cat" "deep learning"`         | term + phrase, AND'd     |
/// | `(cat:dog)`               | `"cat" "dog"`                   | specials stripped, AND'd |
/// | `****`                    | (empty)                         | caller short-circuits    |
/// | `深度 学习`                | `"深度" "学习"`                  | unicode preserved, AND'd |
///
/// Inside a bare token, FTS5 specials (`(`, `:`, `*`, `+`, `-`, `^`, `~`,
/// `"`) are replaced with spaces and the resulting fragments emit as
/// separate AND'd terms — so `cat:dog` becomes `"cat" "dog"` (AND), not
/// `"cat dog"` (adjacency). Inside a phrase the same stripping happens
/// but the result stays one phrase, preserving the user's adjacency intent.
///
/// Boolean operators (`OR`, `NOT`, `NEAR`) are NOT parsed in P1; bare
/// `OR`/`AND`/`NOT` are just words. If we add them later this function
/// grows into a small expression parser.
fn build_fts_query(input: &str) -> String {
  let chars: Vec<char> = input.chars().collect();
  let mut tokens: Vec<String> = Vec::new();
  let mut i = 0;

  while i < chars.len() {
    let c = chars[i];
    if c.is_whitespace() {
      i += 1;
      continue;
    }
    if c == '"' {
      // Phrase: read until matching `"`. Doubled `""` inside a phrase
      // escapes one literal quote (FTS5 convention).
      i += 1;
      let mut phrase = String::new();
      while i < chars.len() {
        if chars[i] == '"' {
          if i + 1 < chars.len() && chars[i + 1] == '"' {
            phrase.push('"');
            i += 2;
          } else {
            break;
          }
        } else {
          phrase.push(chars[i]);
          i += 1;
        }
      }
      if i < chars.len() {
        i += 1; // skip closing `"`
      }
      let safe = strip_fts_specials(&phrase);
      if !safe.is_empty() {
        tokens.push(format!("\"{safe}\""));
      }
    } else {
      // Bare word: read until whitespace or `"`.
      let mut word = String::new();
      while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '"' {
        word.push(chars[i]);
        i += 1;
      }
      // A bare token with internal punctuation (e.g. `cat:dog`) sanitizes
      // to multiple sub-tokens; emit each as its own AND'd term to
      // preserve the casual "everything must appear" expectation.
      let safe = strip_fts_specials(&word);
      for w in safe.split_whitespace() {
        tokens.push(format!("\"{w}\""));
      }
    }
  }

  tokens.join(" ")
}

/// Replace FTS5 special chars with spaces and collapse whitespace.
/// Keeps any Unicode alphanumeric (CJK, accented letters, etc.), `_`, `-`.
fn strip_fts_specials(s: &str) -> String {
  s.chars()
    .map(|c| {
      if c.is_alphanumeric() || c.is_whitespace() || c == '_' || c == '-' {
        c
      } else {
        ' '
      }
    })
    .collect::<String>()
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
}

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::Utc;
  use domain::{NewTopic, NodeType};
  use storage_fs::FsRepository;
  use tempfile::TempDir;

  fn sample_node(id: NodeId, topic: TopicId, parent: Option<NodeId>) -> Node {
    let now = Utc::now();
    Node {
      id,
      topic,
      parent,
      node_type: NodeType::Concept,
      title: "Backpropagation".into(),
      content: "Gradient flows backwards through the network.".into(),
      links: vec![],
      created_at: now,
      updated_at: now,
      color: None,
    }
  }

  #[tokio::test]
  async fn open_in_memory_creates_schema() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let status = idx.status().await.unwrap();
    assert_eq!(status.embed_pending, 0);
    assert!(!status.fts_dirty);
    assert!(!status.embed_available);
  }

  #[tokio::test]
  async fn upsert_then_search_finds_node() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let topic = TopicId::new("test").unwrap();
    let id = NodeId::new();
    idx.upsert(&sample_node(id, topic.clone(), None)).await.unwrap();

    let hits = idx.search_fts("backpropagation", None, 10).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, id);
    assert_eq!(hits[0].topic, topic);
    assert_eq!(hits[0].title, "Backpropagation");
    assert!(
      hits[0].snippet.contains("<b>"),
      "snippet should highlight: {:?}",
      hits[0].snippet
    );
    assert!(hits[0].score > 0.0, "score should be positive after sign flip");
  }

  #[tokio::test]
  async fn search_filters_by_topic() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let topic_a = TopicId::new("ml").unwrap();
    let topic_b = TopicId::new("biology").unwrap();
    idx.upsert(&sample_node(NodeId::new(), topic_a.clone(), None))
      .await
      .unwrap();
    idx
      .upsert(&Node {
        title: "Backpropagation in cells".into(),
        ..sample_node(NodeId::new(), topic_b.clone(), None)
      })
      .await
      .unwrap();

    let only_ml = idx.search_fts("backpropagation", Some(&topic_a), 10).await.unwrap();
    assert_eq!(only_ml.len(), 1);
    assert_eq!(only_ml[0].topic, topic_a);

    let both = idx.search_fts("backpropagation", None, 10).await.unwrap();
    assert_eq!(both.len(), 2);
  }

  #[tokio::test]
  async fn upsert_replaces_existing_content() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let topic = TopicId::new("test").unwrap();
    let id = NodeId::new();
    idx.upsert(&sample_node(id, topic.clone(), None)).await.unwrap();

    let now = Utc::now();
    idx
      .upsert(&Node {
        id,
        topic: topic.clone(),
        parent: None,
        node_type: NodeType::Fact,
        title: "Renamed".into(),
        content: "Totally different body".into(),
        links: vec![],
        created_at: now,
        updated_at: now,
        color: None,
      })
      .await
      .unwrap();

    let stale = idx.search_fts("backpropagation", None, 10).await.unwrap();
    assert_eq!(stale.len(), 0, "stale FTS entry should be gone");
    let fresh = idx.search_fts("totally different", None, 10).await.unwrap();
    assert_eq!(fresh.len(), 1);
    assert_eq!(fresh[0].title, "Renamed");
  }

  #[tokio::test]
  async fn delete_removes_from_all_tables() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let topic = TopicId::new("test").unwrap();
    let id = NodeId::new();
    let other = NodeId::new();
    idx
      .upsert(&Node {
        links: vec![other],
        ..sample_node(id, topic.clone(), None)
      })
      .await
      .unwrap();

    idx.delete(&id).await.unwrap();

    let hits = idx.search_fts("backpropagation", None, 10).await.unwrap();
    assert_eq!(hits.len(), 0);

    let count = idx
      .conn
      .call(move |conn| {
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM links", [], |r| r.get(0))?;
        Ok(count)
      })
      .await
      .unwrap();
    assert_eq!(count, 0);
  }

  #[tokio::test]
  async fn fts_query_sanitization_drops_special_chars() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let topic = TopicId::new("test").unwrap();
    idx.upsert(&sample_node(NodeId::new(), topic.clone(), None))
      .await
      .unwrap();

    // These would all error in raw FTS5 but our sanitizer handles them.
    let hits = idx.search_fts("backpropagation: (network)", None, 10).await.unwrap();
    assert_eq!(hits.len(), 1);

    let hits2 = idx.search_fts("****", None, 10).await.unwrap();
    assert!(
      hits2.is_empty(),
      "all-special query should return no results without erroring"
    );
  }

  #[test]
  fn build_fts_query_handles_input_shapes() {
    assert_eq!(build_fts_query(""), "");
    assert_eq!(build_fts_query("cat"), "\"cat\"");
    assert_eq!(build_fts_query("cat dog"), "\"cat\" \"dog\"");
    assert_eq!(build_fts_query("\"deep learning\""), "\"deep learning\"");
    assert_eq!(
      build_fts_query("cat \"deep learning\""),
      "\"cat\" \"deep learning\""
    );
    assert_eq!(build_fts_query("(cat:dog)"), "\"cat\" \"dog\"");
    assert_eq!(build_fts_query("****"), "");
    assert_eq!(build_fts_query("   "), "");
    assert_eq!(build_fts_query("深度学习"), "\"深度学习\"");
    assert_eq!(build_fts_query("深度 学习"), "\"深度\" \"学习\"");
    // Doubled `""` inside a phrase escapes a literal quote, then our
    // stripper replaces it with a space.
    assert_eq!(build_fts_query("\"say \"\"hi\"\" loud\""), "\"say hi loud\"");
    // Unclosed quote: read until end as phrase content.
    assert_eq!(build_fts_query("cat \"deep learn"), "\"cat\" \"deep learn\"");
  }

  #[tokio::test]
  async fn phrase_search_requires_adjacency() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let topic = TopicId::new("test").unwrap();
    let now = Utc::now();

    let id_a = NodeId::new();
    idx
      .upsert(&Node {
        id: id_a,
        topic: topic.clone(),
        parent: None,
        node_type: NodeType::Concept,
        title: "A".into(),
        content: "deep learning models".into(),
        links: vec![],
        created_at: now,
        updated_at: now,
        color: None,
      })
      .await
      .unwrap();

    let id_b = NodeId::new();
    idx
      .upsert(&Node {
        id: id_b,
        topic: topic.clone(),
        parent: None,
        node_type: NodeType::Concept,
        title: "B".into(),
        content: "learning is deep work".into(),
        links: vec![],
        created_at: now,
        updated_at: now,
        color: None,
      })
      .await
      .unwrap();

    // Bare AND: both nodes contain both words, both match.
    let any_order = idx.search_fts("deep learning", None, 10).await.unwrap();
    assert_eq!(any_order.len(), 2);

    // Phrase: only A has them adjacent.
    let adjacent = idx.search_fts("\"deep learning\"", None, 10).await.unwrap();
    assert_eq!(adjacent.len(), 1);
    assert_eq!(adjacent[0].id, id_a);
  }

  #[tokio::test]
  async fn mixed_bare_and_phrase_anding() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let topic = TopicId::new("test").unwrap();
    let now = Utc::now();

    let id_match = NodeId::new();
    idx
      .upsert(&Node {
        id: id_match,
        topic: topic.clone(),
        parent: None,
        node_type: NodeType::Concept,
        title: "Match".into(),
        content: "deep learning rate adjusts during training".into(),
        links: vec![],
        created_at: now,
        updated_at: now,
        color: None,
      })
      .await
      .unwrap();

    let id_partial = NodeId::new();
    idx
      .upsert(&Node {
        id: id_partial,
        topic: topic.clone(),
        parent: None,
        node_type: NodeType::Concept,
        title: "Partial".into(),
        content: "learning is deep but rate is fixed".into(),
        links: vec![],
        created_at: now,
        updated_at: now,
        color: None,
      })
      .await
      .unwrap();

    // `"deep learning" rate` → phrase + bare AND: only the first matches
    // (second has both words but not adjacent).
    let hits = idx.search_fts("\"deep learning\" rate", None, 10).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, id_match);
  }

  #[tokio::test]
  async fn search_vec_returns_unavailable_in_phase_1() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let result = idx.search_vec(&vec![0.0; 768], None, 10).await;
    assert!(matches!(result, Err(ForestError::EmbedUnavailable)));
  }

  #[tokio::test]
  async fn rebuild_from_repopulates_index_from_repo() {
    let tmp = TempDir::new().unwrap();
    let repo = FsRepository::open(tmp.path()).await.unwrap();
    let topic = repo
      .create_topic(NewTopic {
        title: "Knowledge".into(),
        slug: None,
      })
      .await
      .unwrap();
    let now = Utc::now();
    for title in ["Alpha", "Beta", "Gamma"] {
      repo
        .write_node(&Node {
          id: NodeId::new(),
          topic: topic.id.clone(),
          parent: Some(topic.root_node_id),
          node_type: NodeType::Concept,
          title: title.into(),
          content: format!("Body about {title} stuff."),
          links: vec![],
          created_at: now,
          updated_at: now,
          color: None,
        })
        .await
        .unwrap();
    }

    let idx = SqliteIndex::open_in_memory().await.unwrap();
    idx.rebuild_from(&repo).await.unwrap();

    let hits = idx.search_fts("body stuff", None, 10).await.unwrap();
    assert_eq!(hits.len(), 3);

    let topic_filter = idx.search_fts("Knowledge", Some(&topic.id), 10).await.unwrap();
    assert_eq!(topic_filter.len(), 1, "root has title 'Knowledge'");

    let status = idx.status().await.unwrap();
    assert!(status.last_scan.is_some(), "rebuild should set last_full_scan");
  }
}
