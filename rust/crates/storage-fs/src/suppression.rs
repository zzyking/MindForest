//! Self-write suppression for the vault watcher.
//!
//! FsRepository records `(path, mtime)` immediately after every internal
//! atomic write. The watcher consults this registry on each event and
//! drops any whose path has a matching mtime within a 500ms window.
//! Genuine external edits don't match (their mtime differs from the
//! registered one) and pass through to consumers.
//!
//! Scope (intentional): only same-path writes are suppressed. The
//! Removed event for the old path during a title-change rename is
//! NOT suppressed here — consumers (app-core) detect this case
//! by observing that no node currently lives at that path.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

const SUPPRESS_WINDOW: Duration = Duration::from_millis(500);

/// Shared between FsRepository (recorder) and the watcher (consumer).
/// Internally a sync `Mutex<HashMap>` because the watcher callback runs
/// on a non-tokio thread; the lock is held only for the duration of a
/// single map operation, no I/O inside.
#[derive(Debug, Default)]
pub struct RecentWrites {
  inner: Mutex<HashMap<PathBuf, RecentEntry>>,
}

#[derive(Debug, Clone, Copy)]
struct RecentEntry {
  registered_at: Instant,
  mtime: SystemTime,
}

impl RecentWrites {
  /// Record that `path` was just written internally and its on-disk
  /// mtime is `mtime`. Opportunistically prunes stale entries to keep
  /// the map bounded by recent write rate.
  pub(crate) fn record(&self, path: PathBuf, mtime: SystemTime) {
    let mut map = self.inner.lock().expect("RecentWrites mutex poisoned");
    map.insert(
      path,
      RecentEntry {
        registered_at: Instant::now(),
        mtime,
      },
    );
    map.retain(|_, e| e.registered_at.elapsed() < SUPPRESS_WINDOW);
  }

  /// Returns `true` if `path` has a recent registered write whose mtime
  /// matches `current_mtime` and is within the suppression window.
  ///
  /// Entries are NOT removed on a match because notify backends often
  /// fire multiple events per write (e.g. Create + Modify on macOS) —
  /// every one of them needs the same answer. Entries are removed only
  /// when they expire; stale entries are also pruned opportunistically
  /// inside `record`.
  pub(crate) fn check(&self, path: &Path, current_mtime: Option<SystemTime>) -> bool {
    let mut map = self.inner.lock().expect("RecentWrites mutex poisoned");
    let entry = match map.get(path).copied() {
      Some(e) => e,
      None => return false,
    };
    if entry.registered_at.elapsed() >= SUPPRESS_WINDOW {
      map.remove(path);
      return false;
    }
    Some(entry.mtime) == current_mtime
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::thread;

  #[test]
  fn record_then_match_repeatedly() {
    let rw = RecentWrites::default();
    let path = PathBuf::from("/tmp/foo");
    let mtime = SystemTime::now();
    rw.record(path.clone(), mtime);

    // Multiple events per write must all be suppressed.
    assert!(rw.check(&path, Some(mtime)));
    assert!(rw.check(&path, Some(mtime)));
    assert!(rw.check(&path, Some(mtime)));
  }

  #[test]
  fn mtime_mismatch_does_not_suppress() {
    let rw = RecentWrites::default();
    let path = PathBuf::from("/tmp/foo");
    let registered = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
    let observed = SystemTime::UNIX_EPOCH + Duration::from_secs(2000);
    rw.record(path.clone(), registered);
    assert!(!rw.check(&path, Some(observed)));
  }

  #[test]
  fn stale_entry_does_not_suppress() {
    let rw = RecentWrites::default();
    let path = PathBuf::from("/tmp/foo");
    let mtime = SystemTime::now();
    rw.record(path.clone(), mtime);
    thread::sleep(SUPPRESS_WINDOW + Duration::from_millis(50));
    assert!(!rw.check(&path, Some(mtime)));
  }

  #[test]
  fn missing_current_mtime_does_not_suppress() {
    let rw = RecentWrites::default();
    let path = PathBuf::from("/tmp/foo");
    rw.record(path.clone(), SystemTime::now());
    assert!(!rw.check(&path, None));
  }
}
