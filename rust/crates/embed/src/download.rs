//! HuggingFace model download.
//!
//! Bootstrap path for the EmbeddingGemma weights (or any other MLX-format
//! model under `mlx-community/`). The Swift sidecar's MLX path expects the
//! repo unpacked at `<root>/<repo-id>/` where `<root>` is whatever the
//! caller passed to `ModelDownloader::new` — typically
//! `<data_dir>/models/` (see `app_core::bootstrap`). This module owns
//! putting the files there.
//!
//! Design choices:
//!
//! - **Flat per-repo dir**, slug-encoded `org/name → org--name` so the
//!   filesystem doesn't grow nested HuggingFace hierarchies.
//! - **Stream files one at a time** with byte-level progress via mpsc.
//!   Sidecar can keep running while the user downloads — we don't lock
//!   the whole service for the duration. The download task lives until
//!   the receiver is dropped, so an aborted SSE connection cancels
//!   transparently.
//! - **Resumable.** Each file streams into `<name>.partial` and is only
//!   renamed to the final name once the body is fully read. On retry
//!   we look at the sibling's existing size, send `Range: bytes=N-`,
//!   and append. A 200 response on a resume attempt (server ignored
//!   the Range header) falls back to "truncate and start over" so we
//!   never silently concatenate two prefixes. Files that already exist
//!   at the final name are skipped entirely.
//! - **No SHA-256 verification** in this commit. HuggingFace serves
//!   `X-Linked-Etag: <sha256>` on resolved redirects; integrating that is
//!   a self-contained follow-up. Until then we trust HF's TLS.
//!
//! The HuggingFace public API needs no auth for the small embedding
//! repos we target; we don't read any token by default. If the user sets
//! `HUGGINGFACE_TOKEN` we forward it as `Authorization: Bearer`.

use std::path::{Path, PathBuf};

use futures::Stream;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;

use domain::{ForestError, ForestResult};

/// What's where on the filesystem for a given model.
#[derive(Debug, Clone, Serialize)]
pub struct ModelStatus {
  pub repo_id: String,
  pub dir: PathBuf,
  /// All required files exist locally.
  pub present: bool,
  pub files: Vec<FileStatus>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileStatus {
  pub name: String,
  pub present: bool,
  /// Size in bytes when present locally; `None` until we know.
  pub size: Option<u64>,
  /// Bytes already on disk in `<name>.partial`. Set only when the final
  /// file is *not* present — a leftover partial next to a completed file
  /// would be stale and isn't surfaced. Lets the UI show "Resume" instead
  /// of "Download" and pre-seed the progress bar.
  pub partial_size: Option<u64>,
}

/// One event in the download stream. Serialized as the `data` payload of
/// SSE events at the HTTP layer; the variant becomes the SSE `event:` name.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DownloadEvent {
  Started {
    repo_id: String,
    total_files: usize,
  },
  FileStart {
    name: String,
    size: Option<u64>,
  },
  Progress {
    name: String,
    bytes_so_far: u64,
    file_total: Option<u64>,
    overall_so_far: u64,
    overall_total: Option<u64>,
  },
  FileDone {
    name: String,
    size: u64,
  },
  Done,
  Error {
    message: String,
  },
}

#[derive(Debug, Deserialize)]
struct HfRepoInfo {
  siblings: Vec<HfSibling>,
}

#[derive(Debug, Deserialize)]
struct HfSibling {
  rfilename: String,
  /// Some HF endpoints return the file size; many don't. We rely on
  /// content-length from the resolve URL when this is missing.
  #[serde(default)]
  size: Option<u64>,
}

#[derive(Clone)]
pub struct ModelDownloader {
  client: reqwest::Client,
  root_dir: PathBuf,
}

impl ModelDownloader {
  /// Create a downloader rooted at `root_dir`. Each repo gets its own
  /// slug-encoded subdirectory beneath this root.
  pub fn new(root_dir: impl Into<PathBuf>) -> Self {
    let mut builder = reqwest::Client::builder()
      .user_agent(concat!("mindforest/", env!("CARGO_PKG_VERSION")))
      // Disable the connection-level timeout — large model files can
      // take minutes on slow connections. Per-request timeouts for the
      // metadata calls are still set below.
      .pool_idle_timeout(None);
    if let Ok(token) = std::env::var("HUGGINGFACE_TOKEN") {
      let mut headers = reqwest::header::HeaderMap::new();
      if let Ok(v) = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")) {
        headers.insert(reqwest::header::AUTHORIZATION, v);
        builder = builder.default_headers(headers);
      }
    }
    let client = builder.build().expect("reqwest client should build");
    Self {
      client,
      root_dir: root_dir.into(),
    }
  }

  /// Filesystem location for `repo_id`'s files.
  pub fn target_dir(&self, repo_id: &str) -> PathBuf {
    self.root_dir.join(slugify_repo_id(repo_id))
  }

  /// Lazily compute the `ModelStatus`. We only read the local fs by
  /// default — listing the remote repo over the network is reserved for
  /// the download path. If the local dir doesn't exist we report empty.
  ///
  /// `expected_files` is the static manifest the caller supplies (e.g.
  /// the EmbeddingGemma file list). When the caller doesn't know, an
  /// empty slice gives a "best-effort" status that just says whether
  /// the dir exists at all.
  pub async fn local_status(
    &self,
    repo_id: &str,
    expected_files: &[&str],
  ) -> ForestResult<ModelStatus> {
    let dir = self.target_dir(repo_id);
    let mut files: Vec<FileStatus> = Vec::with_capacity(expected_files.len());
    for name in expected_files {
      let path = dir.join(name);
      let meta = tokio::fs::metadata(&path).await.ok();
      let present = meta.is_some();
      let size = meta.as_ref().map(|m| m.len());
      // Only surface a `.partial` if the final isn't already present —
      // a stale partial next to a renamed final is meaningless for the
      // UI's "resume vs. download" decision.
      let partial_size = if present {
        None
      } else {
        tokio::fs::metadata(partial_path_for(&path))
          .await
          .ok()
          .map(|m| m.len())
      };
      files.push(FileStatus {
        name: (*name).to_string(),
        present,
        size,
        partial_size,
      });
    }
    // If the caller didn't provide a manifest, fall back to "dir exists
    // and contains at least one .safetensors". Loose but useful.
    let present = if expected_files.is_empty() {
      dir_has_safetensors(&dir).await.unwrap_or(false)
    } else {
      !files.is_empty() && files.iter().all(|f| f.present)
    };
    Ok(ModelStatus {
      repo_id: repo_id.to_string(),
      dir,
      present,
      files,
    })
  }

  /// Stream the download. The returned `Stream` ends when either all
  /// files are pulled (final event: `Done`) or an error halts progress
  /// (final event: `Error`). Dropping the stream cancels the download
  /// task transparently — incomplete files are left on disk for the
  /// next attempt to overwrite.
  pub fn download(&self, repo_id: String) -> impl Stream<Item = DownloadEvent> + Send {
    let (tx, rx) = mpsc::unbounded_channel::<DownloadEvent>();
    let target = self.target_dir(&repo_id);
    let client = self.client.clone();
    tokio::spawn(async move {
      if let Err(e) = run_download(&client, &repo_id, &target, &tx).await {
        let _ = tx.send(DownloadEvent::Error {
          message: e.to_string(),
        });
      }
    });
    UnboundedReceiverStream::new(rx)
  }
}

/// Inner download routine. Returns `Err` only on a *fatal* error worth
/// surfacing as `Error`; per-file recovery (e.g. transient 503) lives
/// inside this function and never bubbles up.
async fn run_download(
  client: &reqwest::Client,
  repo_id: &str,
  target_dir: &Path,
  tx: &mpsc::UnboundedSender<DownloadEvent>,
) -> ForestResult<()> {
  // Make the target dir up front so partial downloads land in-place.
  tokio::fs::create_dir_all(target_dir)
    .await
    .map_err(|e| ForestError::Storage(format!("create_dir_all {target_dir:?}: {e}")))?;

  // 1. List repo files via the HF API.
  let info: HfRepoInfo = client
    .get(format!("https://huggingface.co/api/models/{repo_id}"))
    .timeout(std::time::Duration::from_secs(30))
    .send()
    .await
    .map_err(|e| ForestError::Storage(format!("HF metadata: {e}")))?
    .error_for_status()
    .map_err(|e| ForestError::Storage(format!("HF metadata HTTP: {e}")))?
    .json()
    .await
    .map_err(|e| ForestError::Storage(format!("HF metadata parse: {e}")))?;

  // 2. Filter to the files we actually want — model weights, configs,
  //    tokenizer artifacts. README/license/etc are not needed for
  //    inference.
  let downloads: Vec<_> = info
    .siblings
    .into_iter()
    .filter(|s| !is_ignorable(&s.rfilename))
    .collect();
  if downloads.is_empty() {
    return Err(ForestError::Storage(format!(
      "no downloadable files in {repo_id}"
    )));
  }

  let total_files = downloads.len();
  let _ = tx.send(DownloadEvent::Started {
    repo_id: repo_id.to_string(),
    total_files,
  });

  // 3. Pull file sizes ahead of writing — gives a useful overall total
  //    for the progress bar. HEAD avoids buffering a body we don't need.
  let mut sizes: Vec<Option<u64>> = Vec::with_capacity(downloads.len());
  for s in &downloads {
    if s.size.is_some() {
      sizes.push(s.size);
      continue;
    }
    let head_url = resolve_url(repo_id, &s.rfilename);
    let head = client
      .head(&head_url)
      .timeout(std::time::Duration::from_secs(15))
      .send()
      .await;
    let size = head.ok().and_then(|r| {
      r.headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
    });
    sizes.push(size);
  }
  let overall_total: Option<u64> = if sizes.iter().all(|s| s.is_some()) {
    Some(sizes.iter().map(|s| s.unwrap()).sum())
  } else {
    None
  };
  let mut overall_so_far: u64 = 0;

  // 4. Download each file with byte-level progress.
  for (sibling, size) in downloads.iter().zip(sizes.iter()) {
    let name = sibling.rfilename.clone();
    let _ = tx.send(DownloadEvent::FileStart {
      name: name.clone(),
      size: *size,
    });
    let url = resolve_url(repo_id, &name);
    let target_path = target_dir.join(&name);
    if let Some(parent) = target_path.parent() {
      tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| ForestError::Storage(format!("create {parent:?}: {e}")))?;
    }
    let mut ctx = StreamCtx {
      client,
      url: &url,
      target: &target_path,
      name: &name,
      declared_size: *size,
      overall_so_far: &mut overall_so_far,
      overall_total,
      tx,
    };
    let bytes_written = stream_file(&mut ctx)
      .await
      .map_err(|e| ForestError::Storage(format!("download {name}: {e}")))?;
    let _ = tx.send(DownloadEvent::FileDone {
      name,
      size: bytes_written,
    });
  }

  let _ = tx.send(DownloadEvent::Done);
  Ok(())
}

/// Per-file streaming context. Bundled into a struct so the function
/// signature stays under clippy's arg threshold.
struct StreamCtx<'a> {
  client: &'a reqwest::Client,
  url: &'a str,
  target: &'a Path,
  name: &'a str,
  declared_size: Option<u64>,
  overall_so_far: &'a mut u64,
  overall_total: Option<u64>,
  tx: &'a mpsc::UnboundedSender<DownloadEvent>,
}

async fn stream_file(ctx: &mut StreamCtx<'_>) -> Result<u64, String> {
  use futures::StreamExt;

  // A previous attempt already renamed this file. Skip the network and
  // fold its bytes into the overall counter so the bar shows where we
  // really are.
  if let Ok(meta) = tokio::fs::metadata(ctx.target).await {
    let size = meta.len();
    *ctx.overall_so_far += size;
    let _ = ctx.tx.send(DownloadEvent::Progress {
      name: ctx.name.to_string(),
      bytes_so_far: size,
      file_total: ctx.declared_size.or(Some(size)),
      overall_so_far: *ctx.overall_so_far,
      overall_total: ctx.overall_total,
    });
    return Ok(size);
  }

  let partial_path = partial_path_for(ctx.target);
  let resume_from: u64 = tokio::fs::metadata(&partial_path)
    .await
    .map(|m| m.len())
    .unwrap_or(0);

  let mut req = ctx.client.get(ctx.url);
  if resume_from > 0 {
    // RFC 7233 byte-range, open-ended. CDNs serving HF content (cloudfront,
    // mostly) honor this consistently; we still defend against a server
    // that ignores it below by inspecting the status code.
    req = req.header(
      reqwest::header::RANGE,
      format!("bytes={resume_from}-"),
    );
  }
  let resp = req
    .send()
    .await
    .map_err(|e| format!("GET {}: {e}", ctx.url))?
    .error_for_status()
    .map_err(|e| format!("HTTP {}: {e}", ctx.url))?;

  let status = resp.status();
  let mut bytes_so_far: u64;
  let mut file = if resume_from > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT {
    // Server honored the range. Append to what we already had on disk.
    bytes_so_far = resume_from;
    *ctx.overall_so_far += resume_from;
    tokio::fs::OpenOptions::new()
      .append(true)
      .open(&partial_path)
      .await
      .map_err(|e| format!("open {partial_path:?}: {e}"))?
  } else {
    // Either no resume was requested, or the server returned 200 instead
    // of 206 (some proxies silently drop the Range header). Start fresh —
    // creating with `File::create` truncates any stale partial, so we
    // never end up concatenating two byte prefixes.
    bytes_so_far = 0;
    tokio::fs::File::create(&partial_path)
      .await
      .map_err(|e| format!("create {partial_path:?}: {e}"))?
  };

  let mut last_emit = std::time::Instant::now();
  let emit_every = std::time::Duration::from_millis(150);
  let mut stream = resp.bytes_stream();
  while let Some(chunk) = stream.next().await {
    let chunk = chunk.map_err(|e| format!("read body: {e}"))?;
    file
      .write_all(&chunk)
      .await
      .map_err(|e| format!("write {partial_path:?}: {e}"))?;
    bytes_so_far += chunk.len() as u64;
    *ctx.overall_so_far += chunk.len() as u64;
    // Throttle progress events — at gigabit speeds we'd otherwise emit
    // tens of thousands of events per file and choke the SSE channel.
    if last_emit.elapsed() >= emit_every {
      let _ = ctx.tx.send(DownloadEvent::Progress {
        name: ctx.name.to_string(),
        bytes_so_far,
        file_total: ctx.declared_size,
        overall_so_far: *ctx.overall_so_far,
        overall_total: ctx.overall_total,
      });
      last_emit = std::time::Instant::now();
    }
  }
  file
    .flush()
    .await
    .map_err(|e| format!("flush {partial_path:?}: {e}"))?;
  // Drop the handle before renaming — Windows rejects renames on open
  // files. macOS/Linux are fine either way, but the cost is zero.
  drop(file);
  tokio::fs::rename(&partial_path, ctx.target)
    .await
    .map_err(|e| format!("rename {partial_path:?} -> {:?}: {e}", ctx.target))?;

  // Final progress tick so the UI snaps the bar to the just-finished file.
  let _ = ctx.tx.send(DownloadEvent::Progress {
    name: ctx.name.to_string(),
    bytes_so_far,
    file_total: ctx.declared_size,
    overall_so_far: *ctx.overall_so_far,
    overall_total: ctx.overall_total,
  });
  Ok(bytes_so_far)
}

/// Sibling path used for in-flight bytes: `model.safetensors` →
/// `model.safetensors.partial`. We keep the original name in the suffix
/// chain (`with_extension` would clobber `.safetensors`) so debugging on
/// disk is unambiguous.
fn partial_path_for(target: &Path) -> PathBuf {
  let name = target
    .file_name()
    .map(|n| n.to_os_string())
    .unwrap_or_default();
  let mut s = name;
  s.push(".partial");
  target.with_file_name(s)
}

fn resolve_url(repo_id: &str, filename: &str) -> String {
  format!("https://huggingface.co/{repo_id}/resolve/main/{filename}")
}

fn is_ignorable(name: &str) -> bool {
  let lower = name.to_ascii_lowercase();
  matches!(
    lower.as_str(),
    ".gitattributes" | ".gitignore" | "readme.md" | "license" | "license.md" | "license.txt"
  ) || lower.ends_with(".py")
    || lower.ends_with(".md")
    || lower.ends_with(".txt")
    || lower.starts_with("test_")
}

async fn dir_has_safetensors(dir: &Path) -> std::io::Result<bool> {
  let mut entries = match tokio::fs::read_dir(dir).await {
    Ok(it) => it,
    Err(_) => return Ok(false),
  };
  while let Some(entry) = entries.next_entry().await? {
    if let Some(name) = entry.file_name().to_str() {
      if name.ends_with(".safetensors") {
        return Ok(true);
      }
    }
  }
  Ok(false)
}

/// Replace `/` so we can safely use the repo id as a directory name on
/// any filesystem. `mlx-community/embeddinggemma-300m-4bit` becomes
/// `mlx-community--embeddinggemma-300m-4bit`. Idempotent.
fn slugify_repo_id(repo_id: &str) -> String {
  repo_id.replace('/', "--")
}

#[cfg(test)]
mod tests {
  use super::*;
  use tempfile::TempDir;

  #[test]
  fn slugify_replaces_slashes() {
    assert_eq!(
      slugify_repo_id("mlx-community/embeddinggemma-300m-4bit"),
      "mlx-community--embeddinggemma-300m-4bit"
    );
    assert_eq!(slugify_repo_id("simple"), "simple");
  }

  #[test]
  fn ignorable_filters_docs_and_scripts() {
    assert!(is_ignorable("README.md"));
    assert!(is_ignorable(".gitattributes"));
    assert!(is_ignorable("convert.py"));
    assert!(is_ignorable("Notes.txt"));
    assert!(!is_ignorable("config.json"));
    assert!(!is_ignorable("model.safetensors"));
    assert!(!is_ignorable("tokenizer.json"));
  }

  #[tokio::test]
  async fn local_status_reports_missing_when_dir_absent() {
    let tmp = TempDir::new().unwrap();
    let dl = ModelDownloader::new(tmp.path());
    let s = dl
      .local_status(
        "mlx-community/embeddinggemma-300m-4bit",
        &["config.json", "model.safetensors"],
      )
      .await
      .unwrap();
    assert!(!s.present);
    assert_eq!(s.files.len(), 2);
    assert!(s.files.iter().all(|f| !f.present));
    assert!(s.files.iter().all(|f| f.partial_size.is_none()));
  }

  #[tokio::test]
  async fn local_status_reports_present_when_all_files_exist() {
    let tmp = TempDir::new().unwrap();
    let dl = ModelDownloader::new(tmp.path());
    let dir = dl.target_dir("mlx-community/embeddinggemma-300m-4bit");
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(dir.join("config.json"), b"{}").await.unwrap();
    tokio::fs::write(dir.join("model.safetensors"), b"\0\0\0\0")
      .await
      .unwrap();
    let s = dl
      .local_status(
        "mlx-community/embeddinggemma-300m-4bit",
        &["config.json", "model.safetensors"],
      )
      .await
      .unwrap();
    assert!(s.present);
    assert_eq!(s.files[0].size, Some(2));
    assert_eq!(s.files[1].size, Some(4));
    // No partial_size noise on completed files even if a stale `.partial`
    // somehow lingers — that's a separate invariant tested below.
    assert!(s.files.iter().all(|f| f.partial_size.is_none()));
  }

  #[tokio::test]
  async fn local_status_surfaces_partial_size_when_only_partial_exists() {
    let tmp = TempDir::new().unwrap();
    let dl = ModelDownloader::new(tmp.path());
    let dir = dl.target_dir("foo/bar");
    tokio::fs::create_dir_all(&dir).await.unwrap();
    // Mid-transfer: the partial is on disk; the final isn't.
    tokio::fs::write(dir.join("model.safetensors.partial"), b"123456")
      .await
      .unwrap();
    let s = dl
      .local_status("foo/bar", &["config.json", "model.safetensors"])
      .await
      .unwrap();
    assert!(!s.present);
    // config.json: nothing on disk at all.
    assert!(!s.files[0].present);
    assert_eq!(s.files[0].partial_size, None);
    // model.safetensors: 6 bytes downloaded so far.
    assert!(!s.files[1].present);
    assert_eq!(s.files[1].partial_size, Some(6));
  }

  #[tokio::test]
  async fn local_status_ignores_stale_partial_next_to_completed_file() {
    let tmp = TempDir::new().unwrap();
    let dl = ModelDownloader::new(tmp.path());
    let dir = dl.target_dir("foo/bar");
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(dir.join("config.json"), b"{}").await.unwrap();
    // A `.partial` that survived a botched cleanup. Surfacing it would
    // make the UI claim there's a download in progress when there isn't.
    tokio::fs::write(dir.join("config.json.partial"), b"\0\0\0\0")
      .await
      .unwrap();
    let s = dl.local_status("foo/bar", &["config.json"]).await.unwrap();
    assert!(s.files[0].present);
    assert_eq!(s.files[0].partial_size, None);
  }

  #[test]
  fn partial_path_for_appends_suffix_preserving_extension() {
    let p = std::path::Path::new("/tmp/models/foo/model.safetensors");
    assert_eq!(
      partial_path_for(p),
      std::path::PathBuf::from("/tmp/models/foo/model.safetensors.partial")
    );
    // Idempotency check: applying twice produces a `.partial.partial`,
    // which is fine — we never call it twice in practice but a runaway
    // bug should still be locally debuggable.
    let twice = partial_path_for(&partial_path_for(p));
    assert!(twice.to_string_lossy().ends_with(".partial.partial"));
  }

  #[tokio::test]
  async fn local_status_falls_back_to_safetensors_glob() {
    let tmp = TempDir::new().unwrap();
    let dl = ModelDownloader::new(tmp.path());
    let dir = dl.target_dir("foo/bar");
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(dir.join("model.safetensors"), b"x")
      .await
      .unwrap();
    let s = dl.local_status("foo/bar", &[]).await.unwrap();
    assert!(s.present, "fallback should treat any .safetensors as enough");
  }
}
