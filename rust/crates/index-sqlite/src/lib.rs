//! `index-sqlite` — derived SQLite index over the vault.
//!
//! The vault (markdown files) is the source of truth; this crate maintains
//! a fully derivable cache of it for fast queries:
//!
//! - `nodes`     — flat metadata (id, topic, parent, type, title, timestamps,
//!   content_hash). Indexed by topic + parent for O(1) tree walks.
//! - `links`     — directed edge list, both directions stored as separate rows.
//! - `nodes_fts` — FTS5 virtual table over (title, content) for keyword search.
//! - `nodes_vec` — sqlite-vec virtual table over fixed-dim float embeddings.
//! - `embed_jobs`— work queue for the embedding pipeline.
//! - `meta`      — kv (schema_version, last_full_scan).
//!
//! Vector search uses cosine distance (sqlite-vec native). The extension
//! is registered once via `sqlite3_auto_extension` on first `SqliteIndex`
//! open — every subsequent connection inherits it. Embeddings are stored
//! as raw f32 bytes; we cast through `bytemuck` so the trip into and out
//! of SQLite is zero-copy.
//!
//! Embedding writes are decoupled from node writes: `upsert` enqueues an
//! `embed_jobs` row tagged with the new `content_hash` and leaves vector
//! computation to the embed worker (see `app-core`). The worker calls
//! `upsert_embedding` to install the result.
//!
//! Search composition (`hybrid`) is done one layer up in `app-core` so
//! this crate stays narrow: FTS in, vec in, ids out.

use std::path::PathBuf;
use std::sync::OnceLock;

use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use rusqlite::params;
use tokio_rusqlite::Connection;

use domain::{
  EmbedJob, ForestError, ForestRepository, ForestResult, IndexStatus, Indexer, Node, NodeId,
  NodeType, SearchHit, TopicId,
};

const SCHEMA_VERSION: i64 = 2;
pub const EMBED_DIM: usize = 768;

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
CREATE INDEX IF NOT EXISTS idx_embed_jobs_status ON embed_jobs(status);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

/// Schema for the vec0 virtual table — kept separate because it depends
/// on the sqlite-vec extension being loaded (auto-extension is registered
/// in `register_vec_extension` before any connection opens).
const VEC_SCHEMA_SQL: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_vec USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[768] distance_metric=cosine
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
    register_vec_extension();
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
    register_vec_extension();
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
        // The vec0 schema runs in its own batch because errors here are
        // useful to surface separately (sqlite-vec link missing → loud
        // failure rather than silent FTS-only fallback).
        conn.execute_batch(VEC_SCHEMA_SQL)?;
        conn.execute(
          "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)",
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
    let content_hash = content_hash_for(&title, &content);
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

        // Embed-jobs queue: enqueue iff the content hash changed (or the
        // row is fresh / errored). If a 'done' row exists with the same
        // hash we leave it alone to avoid re-embedding on no-op upserts.
        let prior: Option<(String, String)> = conn_query_optional(
          &tx,
          "SELECT status, content_hash FROM embed_jobs WHERE id = ?1",
          params![id],
        )?;
        let needs_enqueue = match prior {
          None => true,
          Some((status, hash)) => status != "done" || hash != content_hash,
        };
        if needs_enqueue {
          tx.execute(
            "INSERT INTO embed_jobs (id, content_hash, status, error)
              VALUES (?1, ?2, 'pending', NULL)
              ON CONFLICT(id) DO UPDATE SET
                content_hash = excluded.content_hash,
                status       = 'pending',
                error        = NULL",
            params![id, content_hash],
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
        // Drop the vector too, if present. vec0 silently ignores missing rows.
        tx.execute("DELETE FROM nodes_vec WHERE id = ?1", params![id_str])?;
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
    embedding: &[f32],
    topic: Option<&TopicId>,
    k: usize,
  ) -> ForestResult<Vec<SearchHit>> {
    if embedding.len() != EMBED_DIM {
      return Err(ForestError::Embed(format!(
        "search_vec dim mismatch: expected {EMBED_DIM}, got {}",
        embedding.len()
      )));
    }
    let bytes = bytemuck::cast_slice::<f32, u8>(embedding).to_vec();
    let topic_str = topic.map(|t| t.as_str().to_string());
    // Over-fetch when we have to filter by topic afterwards. vec0 doesn't
    // mix free-form WHERE constraints with KNN cleanly, so we widen the
    // candidate set instead and trim in Rust.
    let candidate_k = if topic_str.is_some() { (k * 4).max(16) } else { k };
    let candidate_k_i64 = candidate_k as i64;
    let final_k = k;

    let rows: Vec<(String, String, String, f64)> = self
      .conn
      .call(move |conn| {
        // Pull KNN ids + distances first, then look up topic/title in
        // `nodes`. vec0 doesn't allow auxiliary WHERE on the same query
        // mixed with `MATCH`, but a JOIN is fine.
        let mut stmt = conn.prepare(
          "SELECT v.id, n.topic, n.title, v.distance
             FROM nodes_vec v
             JOIN nodes n ON n.id = v.id
            WHERE v.embedding MATCH ?1 AND v.k = ?2
            ORDER BY v.distance",
        )?;
        let it = stmt.query_map(params![bytes, candidate_k_i64], |r| {
          Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, f64>(3)?,
          ))
        })?;
        let collected = it.collect::<Result<Vec<_>, _>>()?;
        Ok(collected)
      })
      .await
      .map_err(|e| ForestError::Index(format!("search_vec: {e}")))?;

    let mut hits: Vec<SearchHit> = Vec::with_capacity(final_k.min(rows.len()));
    for (id_s, topic_s, title, distance) in rows {
      if let Some(filter) = &topic_str {
        if &topic_s != filter {
          continue;
        }
      }
      let id: NodeId = id_s.parse()?;
      let topic = TopicId::new(topic_s)?;
      // sqlite-vec's cosine distance is in [0, 2]; convert to similarity
      // in [-1, 1] so callers can treat higher = better consistently
      // with FTS scores.
      let similarity = 1.0 - distance as f32;
      hits.push(SearchHit {
        id,
        topic,
        title,
        snippet: String::new(),
        score: similarity,
      });
      if hits.len() >= final_k {
        break;
      }
    }
    Ok(hits)
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
      // Whether the current Embedder is healthy is decided at the
      // app-core layer; we just report the index's own readiness.
      embed_available: false,
    })
  }

  async fn upsert_embedding(
    &self,
    id: &NodeId,
    content_hash: &str,
    embedding: &[f32],
  ) -> ForestResult<()> {
    if embedding.len() != EMBED_DIM {
      return Err(ForestError::Embed(format!(
        "embedding dim mismatch: expected {EMBED_DIM}, got {}",
        embedding.len()
      )));
    }
    let id_str = id.to_string();
    let content_hash = content_hash.to_string();
    let bytes = bytemuck::cast_slice::<f32, u8>(embedding).to_vec();
    self
      .conn
      .call(move |conn| {
        let tx = conn.transaction()?;
        // Replace-or-insert. vec0 has its own UPSERT semantics — DELETE
        // then INSERT is the documented pattern for changes.
        tx.execute("DELETE FROM nodes_vec WHERE id = ?1", params![id_str])?;
        tx.execute(
          "INSERT INTO nodes_vec (id, embedding) VALUES (?1, ?2)",
          params![id_str, bytes],
        )?;
        // Only mark the job done if the hash still matches — guards
        // against a stale worker reply for a since-edited node.
        tx.execute(
          "UPDATE embed_jobs SET status = 'done', error = NULL
            WHERE id = ?1 AND content_hash = ?2",
          params![id_str, content_hash],
        )?;
        tx.commit()?;
        Ok(())
      })
      .await
      .map_err(|e| ForestError::Index(format!("upsert_embedding: {e}")))
  }

  async fn mark_embed_error(&self, id: &NodeId, message: &str) -> ForestResult<()> {
    let id_str = id.to_string();
    let message = message.to_string();
    self
      .conn
      .call(move |conn| {
        conn.execute(
          "UPDATE embed_jobs SET status = 'error', error = ?2 WHERE id = ?1",
          params![id_str, message],
        )?;
        Ok(())
      })
      .await
      .map_err(|e| ForestError::Index(format!("mark_embed_error: {e}")))
  }

  async fn pending_embed_jobs(&self, limit: usize) -> ForestResult<Vec<EmbedJob>> {
    let limit = limit as i64;
    let rows: Vec<(String, String)> = self
      .conn
      .call(move |conn| {
        let mut stmt = conn.prepare(
          "SELECT id, content_hash FROM embed_jobs
            WHERE status = 'pending'
            ORDER BY rowid
            LIMIT ?1",
        )?;
        let it = stmt.query_map(params![limit], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let collected = it.collect::<Result<Vec<_>, _>>()?;
        Ok(collected)
      })
      .await
      .map_err(|e| ForestError::Index(format!("pending_embed_jobs: {e}")))?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, hash) in rows {
      let id: NodeId = id.parse()?;
      out.push(EmbedJob { id, content_hash: hash });
    }
    Ok(out)
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
           DELETE FROM embed_jobs;
           DELETE FROM nodes_vec;",
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

/// Hash of the embeddable payload (title + content). Title is included
/// because it materially affects embeddings — renaming a node should
/// re-embed even if the body is unchanged.
pub fn content_hash_for(title: &str, content: &str) -> String {
  let mut hasher = blake3::Hasher::new();
  hasher.update(title.as_bytes());
  hasher.update(b"\n");
  hasher.update(content.as_bytes());
  hasher.finalize().to_hex().to_string()
}

/// Run a `SELECT` that may return zero or one row; treat zero rows as
/// `Ok(None)` rather than the rusqlite default of `Err(QueryReturnedNoRows)`.
fn conn_query_optional<T>(
  tx: &rusqlite::Transaction<'_>,
  sql: &str,
  params: impl rusqlite::Params,
) -> rusqlite::Result<Option<(T, T)>>
where
  T: rusqlite::types::FromSql + 'static,
{
  let mut stmt = tx.prepare(sql)?;
  let mut rows = stmt.query(params)?;
  match rows.next()? {
    Some(row) => Ok(Some((row.get(0)?, row.get(1)?))),
    None => Ok(None),
  }
}

/// Register sqlite-vec as a SQLite auto-extension. Idempotent — wrapped
/// in a `OnceLock` so subsequent connections inherit the registration
/// without re-installing.
///
/// `sqlite3_auto_extension` takes an `Option<unsafe extern "C" fn()>`,
/// but `sqlite_vec::sqlite3_vec_init` carries the real entry-point
/// signature `(*mut sqlite3, *mut *mut c_char, *const sqlite3_api_routines) -> c_int`.
/// SQLite calls auto-extensions with the matching ABI regardless of the
/// declared zero-arg type — the transmute is the documented bridge.
fn register_vec_extension() {
  static REGISTERED: OnceLock<()> = OnceLock::new();
  REGISTERED.get_or_init(|| {
    // SAFETY: we pass a static, never-freed function pointer to a
    // SQLite C API that expects the auto-extension calling convention.
    // The C ABI between sqlite-vec's `sqlite3_vec_init` and rusqlite's
    // `xEntryPoint` slot agrees in practice (both are SQLite extension
    // entrypoints) but the Rust types differ slightly (`*mut *const i8`
    // vs `*mut *mut c_char`), so transmute is required.
    unsafe {
      type Entry = unsafe extern "C" fn(
        *mut rusqlite::ffi::sqlite3,
        *mut *const std::os::raw::c_char,
        *const rusqlite::ffi::sqlite3_api_routines,
      ) -> std::os::raw::c_int;
      let entry: Entry = std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ());
      rusqlite::ffi::sqlite3_auto_extension(Some(entry));
    }
  });
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

  fn unit_vec(seed: u8) -> Vec<f32> {
    // Build a 768-dim vector that's mostly zero except for a single
    // distinguishing feature; norm = 1 so cosine distance = 1 - dot.
    let mut v = vec![0.0f32; EMBED_DIM];
    v[seed as usize % EMBED_DIM] = 1.0;
    v
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
    idx
      .upsert_embedding(&id, &content_hash_for("Backpropagation", "Gradient flows backwards through the network."), &unit_vec(7))
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

    // Vector entry should be gone too.
    let vec_count = idx
      .conn
      .call(move |conn| {
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM nodes_vec", [], |r| r.get(0))?;
        Ok(n)
      })
      .await
      .unwrap();
    assert_eq!(vec_count, 0);
  }

  #[tokio::test]
  async fn fts_query_sanitization_drops_special_chars() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let topic = TopicId::new("test").unwrap();
    idx.upsert(&sample_node(NodeId::new(), topic.clone(), None))
      .await
      .unwrap();

    let hits = idx.search_fts("backpropagation: (network)", None, 10).await.unwrap();
    assert_eq!(hits.len(), 1);

    let hits2 = idx.search_fts("****", None, 10).await.unwrap();
    assert!(hits2.is_empty());
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
    assert_eq!(build_fts_query("\"say \"\"hi\"\" loud\""), "\"say hi loud\"");
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

    let any_order = idx.search_fts("deep learning", None, 10).await.unwrap();
    assert_eq!(any_order.len(), 2);

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

    let hits = idx.search_fts("\"deep learning\" rate", None, 10).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, id_match);
  }

  #[tokio::test]
  async fn upsert_enqueues_embed_job_on_first_write() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let topic = TopicId::new("test").unwrap();
    let id = NodeId::new();
    idx.upsert(&sample_node(id, topic.clone(), None)).await.unwrap();

    let pending = idx.pending_embed_jobs(10).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, id);
  }

  #[tokio::test]
  async fn upsert_skips_enqueue_when_content_unchanged_after_done() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let topic = TopicId::new("test").unwrap();
    let id = NodeId::new();
    let node = sample_node(id, topic.clone(), None);
    idx.upsert(&node).await.unwrap();

    let hash = content_hash_for(&node.title, &node.content);
    idx.upsert_embedding(&id, &hash, &unit_vec(1)).await.unwrap();

    // Re-upsert identical content. Job should stay 'done', no re-queue.
    idx.upsert(&node).await.unwrap();
    let pending = idx.pending_embed_jobs(10).await.unwrap();
    assert!(pending.is_empty(), "no-op re-upsert should not re-queue");
  }

  #[tokio::test]
  async fn upsert_reenqueues_when_content_changes_after_done() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let topic = TopicId::new("test").unwrap();
    let id = NodeId::new();
    let node = sample_node(id, topic.clone(), None);
    idx.upsert(&node).await.unwrap();

    let hash_v1 = content_hash_for(&node.title, &node.content);
    idx.upsert_embedding(&id, &hash_v1, &unit_vec(1)).await.unwrap();

    // Edit content — should re-queue.
    let now = Utc::now();
    idx
      .upsert(&Node {
        content: "fully revised body".into(),
        updated_at: now,
        ..node.clone()
      })
      .await
      .unwrap();
    let pending = idx.pending_embed_jobs(10).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, id);
    assert_ne!(pending[0].content_hash, hash_v1);
  }

  #[tokio::test]
  async fn upsert_embedding_rejects_dim_mismatch() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let id = NodeId::new();
    let bad = idx.upsert_embedding(&id, "deadbeef", &[0.0; 7]).await;
    assert!(matches!(bad, Err(ForestError::Embed(_))));
  }

  #[tokio::test]
  async fn search_vec_returns_topk_by_cosine_similarity() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let topic = TopicId::new("test").unwrap();
    let now = Utc::now();

    // Three nodes with orthogonal "feature" vectors. The query vector
    // matches node_b exactly, so it should rank first.
    let id_a = NodeId::new();
    let id_b = NodeId::new();
    let id_c = NodeId::new();
    for (id, vec_seed) in [(id_a, 0u8), (id_b, 1), (id_c, 2)] {
      let n = Node {
        id,
        topic: topic.clone(),
        parent: None,
        node_type: NodeType::Concept,
        title: format!("node-{id}"),
        content: format!("body-{id}"),
        links: vec![],
        created_at: now,
        updated_at: now,
        color: None,
      };
      idx.upsert(&n).await.unwrap();
      let h = content_hash_for(&n.title, &n.content);
      idx.upsert_embedding(&id, &h, &unit_vec(vec_seed)).await.unwrap();
    }

    let hits = idx.search_vec(&unit_vec(1), None, 3).await.unwrap();
    assert_eq!(hits.len(), 3);
    assert_eq!(hits[0].id, id_b, "exact match should rank first");
    // cosine similarity of orthogonal unit vectors is 0; same-direction is 1.
    assert!(hits[0].score > 0.99);
    assert!(hits[1].score < 0.5);
  }

  #[tokio::test]
  async fn search_vec_filters_by_topic() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let now = Utc::now();
    let topic_a = TopicId::new("alpha").unwrap();
    let topic_b = TopicId::new("beta").unwrap();
    for (topic, id) in [(topic_a.clone(), NodeId::new()), (topic_b.clone(), NodeId::new())] {
      let n = Node {
        id,
        topic: topic.clone(),
        parent: None,
        node_type: NodeType::Concept,
        title: format!("n-{id}"),
        content: format!("body-{id}"),
        links: vec![],
        created_at: now,
        updated_at: now,
        color: None,
      };
      idx.upsert(&n).await.unwrap();
      let h = content_hash_for(&n.title, &n.content);
      idx.upsert_embedding(&id, &h, &unit_vec(5)).await.unwrap();
    }

    let only_alpha = idx.search_vec(&unit_vec(5), Some(&topic_a), 10).await.unwrap();
    assert_eq!(only_alpha.len(), 1);
    assert_eq!(only_alpha[0].topic, topic_a);
  }

  #[tokio::test]
  async fn search_vec_dim_mismatch_errors() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let bad = idx.search_vec(&[0.0; 7], None, 5).await;
    assert!(matches!(bad, Err(ForestError::Embed(_))));
  }

  #[tokio::test]
  async fn rebuild_clears_vec_table() {
    let idx = SqliteIndex::open_in_memory().await.unwrap();
    let topic = TopicId::new("test").unwrap();
    let id = NodeId::new();
    let n = sample_node(id, topic.clone(), None);
    idx.upsert(&n).await.unwrap();
    let h = content_hash_for(&n.title, &n.content);
    idx.upsert_embedding(&id, &h, &unit_vec(11)).await.unwrap();

    let tmp = TempDir::new().unwrap();
    let repo = FsRepository::open(tmp.path()).await.unwrap();
    idx.rebuild_from(&repo).await.unwrap();
    let after = idx
      .conn
      .call(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM nodes_vec", [], |r| r.get::<_, i64>(0))?))
      .await
      .unwrap();
    assert_eq!(after, 0);
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

    // After rebuild, every node is queued for embedding.
    let pending = idx.pending_embed_jobs(100).await.unwrap();
    assert_eq!(pending.len(), 4); // root + Alpha/Beta/Gamma
  }
}
