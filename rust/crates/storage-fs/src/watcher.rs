//! Filesystem watcher for the vault.
//!
//! Wraps `notify-debouncer-full` with a 200ms debounce, filters out
//! non-markdown files and tempfile noise, and forwards a normalized
//! `WatchEvent` stream over a tokio mpsc channel.
//!
//! Suppression of internal-write self-events is intentionally **not**
//! implemented at this layer. Consumers (app-core) dedupe by content
//! hash before re-indexing, which makes internal writes idempotent
//! without coupling FsRepository state to the watcher.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use tokio::sync::mpsc;

use domain::{ForestError, ForestResult};

use crate::suppression::RecentWrites;

/// Logical filesystem change inside the vault. Paths are absolute.
#[derive(Debug, Clone)]
pub enum WatchEvent {
  /// File was created or modified.
  Changed(PathBuf),
  /// File was removed (or moved away).
  Removed(PathBuf),
}

/// Owns the underlying debouncer; dropping it stops the watcher.
pub struct WatcherHandle {
  pub events: mpsc::UnboundedReceiver<WatchEvent>,
  _debouncer: Debouncer<RecommendedWatcher, FileIdMap>,
}

/// Begin watching `vault` recursively, with no self-write suppression.
/// Returns a handle whose `events` receiver yields `WatchEvent`s for
/// `.md` files until the handle is dropped.
pub fn watch_vault(vault: &Path) -> ForestResult<WatcherHandle> {
  watch_vault_with_suppression(vault, None)
}

/// Like `watch_vault`, but consults `suppression` (if provided) before
/// emitting each event. If the event's path has a matching mtime in
/// the registry within the suppression window, the event is dropped.
/// FsRepository::watch() uses this to filter out its own writes.
pub fn watch_vault_with_suppression(
  vault: &Path,
  suppression: Option<Arc<RecentWrites>>,
) -> ForestResult<WatcherHandle> {
  let (out_tx, out_rx) = mpsc::unbounded_channel::<WatchEvent>();
  let cb_tx = out_tx.clone();
  let cb_suppression = suppression.clone();

  let mut debouncer = new_debouncer(
    Duration::from_millis(200),
    None,
    move |res: DebounceEventResult| {
      forward_events(res, &cb_tx, cb_suppression.as_ref());
    },
  )
  .map_err(|e| ForestError::Storage(format!("watcher init: {e}")))?;

  debouncer
    .watcher()
    .watch(vault, RecursiveMode::Recursive)
    .map_err(|e| ForestError::Storage(format!("watcher watch: {e}")))?;

  Ok(WatcherHandle {
    events: out_rx,
    _debouncer: debouncer,
  })
}

fn forward_events(
  res: DebounceEventResult,
  tx: &mpsc::UnboundedSender<WatchEvent>,
  suppression: Option<&Arc<RecentWrites>>,
) {
  let events = match res {
    Ok(events) => events,
    Err(errs) => {
      for err in errs {
        tracing::warn!("watcher error: {err}");
      }
      return;
    }
  };
  // Classify by current filesystem state rather than notify's EventKind —
  // FSEvents on macOS reports deletes in several disguises (Remove, Modify::Name,
  // even Modify::Metadata) and probing existence is unambiguous.
  for ev in events {
    for path in &ev.event.paths {
      if !is_relevant(path) {
        continue;
      }
      // Self-write suppression: read current mtime BEFORE classification
      // (a removed file has no mtime → suppression won't match → Removed
      // events for our own writes still fire, but consumers ignore them
      // for paths with no current node mapping). Canonicalize before
      // lookup — see atomic_write's matching note about macOS
      // /var → /private/var symlinks.
      if let Some(rw) = suppression {
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.clone());
        let mtime = std::fs::metadata(&canonical).ok().and_then(|m| m.modified().ok());
        if rw.check(&canonical, mtime) {
          continue;
        }
      }
      let we = if path.exists() {
        WatchEvent::Changed(path.clone())
      } else {
        WatchEvent::Removed(path.clone())
      };
      let _ = tx.send(we);
    }
  }
}

fn is_relevant(path: &Path) -> bool {
  let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return false };
  // .md files only; skip dotfiles (incl. tempfile patterns like ".tmpAbCd")
  // and Finder/OS noise (.DS_Store, ._foo).
  name.ends_with(".md") && !name.starts_with('.')
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::Duration;
  use tempfile::TempDir;
  use tokio::time::timeout;

  #[tokio::test]
  async fn watcher_emits_change_for_external_write() {
    let tmp = TempDir::new().unwrap();
    // notify needs the dir to exist before watching
    tokio::fs::create_dir_all(tmp.path().join("topic-a")).await.unwrap();
    let mut handle = watch_vault(tmp.path()).expect("watcher start");

    let target = tmp.path().join("topic-a").join("note--01HV6Q3Y9XKMTZP4N2D8WBA0F7.md");
    tokio::fs::write(&target, "---\nid: 01HV6Q3Y9XKMTZP4N2D8WBA0F7\n---\n").await.unwrap();

    let event = timeout(Duration::from_secs(2), handle.events.recv())
      .await
      .expect("watcher should fire within 2s")
      .expect("channel still open");
    match event {
      WatchEvent::Changed(p) => assert!(p.ends_with("note--01HV6Q3Y9XKMTZP4N2D8WBA0F7.md")),
      WatchEvent::Removed(p) => panic!("expected Changed, got Removed({p:?})"),
    }
  }

  #[tokio::test]
  async fn watcher_emits_removed_on_delete() {
    let tmp = TempDir::new().unwrap();
    tokio::fs::create_dir_all(tmp.path().join("topic-b")).await.unwrap();
    let mut handle = watch_vault(tmp.path()).expect("watcher start");

    let target = tmp.path().join("topic-b").join("doomed--01HV6Q3Y9XKMTZP4N2D8WBA0F8.md");
    tokio::fs::write(&target, "---\nid: 01HV6Q3Y9XKMTZP4N2D8WBA0F8\n---\n").await.unwrap();

    // Wait for the create event so notify's FileIdMap has registered the file.
    let mut saw_create = false;
    while let Ok(Some(ev)) = timeout(Duration::from_secs(2), handle.events.recv()).await {
      if let WatchEvent::Changed(p) = &ev {
        if p.ends_with("doomed--01HV6Q3Y9XKMTZP4N2D8WBA0F8.md") {
          saw_create = true;
          break;
        }
      }
    }
    assert!(saw_create, "expected Changed event before delete");

    tokio::fs::remove_file(&target).await.unwrap();

    let mut saw_removed = false;
    while let Ok(Some(ev)) = timeout(Duration::from_secs(2), handle.events.recv()).await {
      if let WatchEvent::Removed(p) = ev {
        if p.ends_with("doomed--01HV6Q3Y9XKMTZP4N2D8WBA0F8.md") {
          saw_removed = true;
          break;
        }
      }
    }
    assert!(saw_removed, "expected Removed event for the deleted file");
  }

  #[tokio::test]
  async fn watcher_ignores_non_md_and_dotfiles() {
    let tmp = TempDir::new().unwrap();
    tokio::fs::create_dir_all(tmp.path().join("topic-c")).await.unwrap();
    let mut handle = watch_vault(tmp.path()).expect("watcher start");

    // These should all be ignored
    tokio::fs::write(tmp.path().join("topic-c").join(".tmp_internal"), "x").await.unwrap();
    tokio::fs::write(tmp.path().join("topic-c").join(".DS_Store"), "x").await.unwrap();
    tokio::fs::write(tmp.path().join("topic-c").join("README.txt"), "x").await.unwrap();

    let result = timeout(Duration::from_millis(800), handle.events.recv()).await;
    assert!(
      result.is_err() || matches!(result, Ok(None)),
      "expected no events, got {result:?}"
    );
  }
}
