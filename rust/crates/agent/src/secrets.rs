//! `secrets` — pluggable secret store for provider API keys.
//!
//! Production builds use the OS native credential store via the
//! `keyring` crate: macOS Keychain, Linux Secret Service (D-Bus),
//! Windows Credential Manager. Users can audit and revoke stored
//! credentials in their OS's own UI — on macOS that's "Keychain Access"
//! filtering on the service name configured by `KeyringStore::new`.
//!
//! Tests use `InMemoryStore`; routes/proposer code only sees the trait
//! object so the backend swap is invisible.
//!
//! ## Account naming
//!
//! `account` is the provider name (`"openai"`, `"anthropic"`). One row
//! per provider per service. The keychain entry's "service" field is
//! whatever the caller passes to `KeyringStore::new` — currently
//! `"com.mindforest.agent"` (see `app-core::bootstrap`).

use std::collections::HashMap;
use std::sync::Mutex;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SecretError {
  /// Backend reported a failure other than "no such entry" (which is
  /// represented as `Ok(None)` from `get` and a no-op from `delete`).
  #[error("secret store backend: {0}")]
  Backend(String),
}

pub trait SecretStore: Send + Sync + std::fmt::Debug {
  /// Read a secret. Missing entry returns `Ok(None)`, not an error —
  /// callers shouldn't have to distinguish "no key set" from
  /// "backend exploded" by inspecting an opaque error message.
  fn get(&self, account: &str) -> Result<Option<String>, SecretError>;

  /// Write (creating or overwriting). Empty `secret` is treated as a
  /// real value, not a deletion — use `delete` for that explicitly so
  /// the intent is in the call site, not the data.
  fn set(&self, account: &str, secret: &str) -> Result<(), SecretError>;

  /// Remove an entry. Idempotent: deleting a missing entry succeeds.
  fn delete(&self, account: &str) -> Result<(), SecretError>;
}

/// OS-native keyring backend.
#[derive(Debug, Clone)]
pub struct KeyringStore {
  service: String,
}

impl KeyringStore {
  /// `service` shows up verbatim in the OS credential manager. Use a
  /// reverse-DNS-ish identifier so users can tell which app owns the
  /// entry — `com.mindforest.agent` is the convention.
  pub fn new(service: impl Into<String>) -> Self {
    Self {
      service: service.into(),
    }
  }
}

impl SecretStore for KeyringStore {
  fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
    let entry = keyring::Entry::new(&self.service, account)
      .map_err(|e| SecretError::Backend(e.to_string()))?;
    match entry.get_password() {
      Ok(s) => Ok(Some(s)),
      Err(keyring::Error::NoEntry) => Ok(None),
      Err(e) => Err(SecretError::Backend(e.to_string())),
    }
  }

  fn set(&self, account: &str, secret: &str) -> Result<(), SecretError> {
    let entry = keyring::Entry::new(&self.service, account)
      .map_err(|e| SecretError::Backend(e.to_string()))?;
    entry
      .set_password(secret)
      .map_err(|e| SecretError::Backend(e.to_string()))
  }

  fn delete(&self, account: &str) -> Result<(), SecretError> {
    let entry = keyring::Entry::new(&self.service, account)
      .map_err(|e| SecretError::Backend(e.to_string()))?;
    match entry.delete_credential() {
      Ok(()) => Ok(()),
      Err(keyring::Error::NoEntry) => Ok(()),
      Err(e) => Err(SecretError::Backend(e.to_string())),
    }
  }
}

/// In-process backend used by unit tests and by API integration tests
/// that don't want to touch the host's actual keychain.
#[derive(Debug, Default)]
pub struct InMemoryStore {
  map: Mutex<HashMap<String, String>>,
}

impl InMemoryStore {
  pub fn new() -> Self {
    Self::default()
  }
}

impl SecretStore for InMemoryStore {
  fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
    Ok(self.map.lock().unwrap().get(account).cloned())
  }

  fn set(&self, account: &str, secret: &str) -> Result<(), SecretError> {
    self
      .map
      .lock()
      .unwrap()
      .insert(account.to_string(), secret.to_string());
    Ok(())
  }

  fn delete(&self, account: &str) -> Result<(), SecretError> {
    self.map.lock().unwrap().remove(account);
    Ok(())
  }
}

/// Mask an API key for display: keep the first 3 and last 4 chars,
/// elide the middle with `…`. Matches the fingerprint format the
/// industry has converged on (OpenAI dashboard, AWS console, etc).
/// Returns `None` for inputs too short to mask safely — better to
/// render nothing than leak a 6-char "secret" verbatim.
pub fn mask_secret(s: &str) -> Option<String> {
  let trimmed = s.trim();
  let chars: Vec<char> = trimmed.chars().collect();
  if chars.len() < 8 {
    return None;
  }
  let head: String = chars.iter().take(3).collect();
  let tail: String = chars.iter().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
  Some(format!("{head}…{tail}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn in_memory_roundtrip() {
    let s = InMemoryStore::new();
    assert!(s.get("openai").unwrap().is_none());
    s.set("openai", "sk-test-abcd1234").unwrap();
    assert_eq!(s.get("openai").unwrap().as_deref(), Some("sk-test-abcd1234"));
    s.set("openai", "sk-test-replaced").unwrap();
    assert_eq!(s.get("openai").unwrap().as_deref(), Some("sk-test-replaced"));
    s.delete("openai").unwrap();
    assert!(s.get("openai").unwrap().is_none());
    // Delete-missing is a no-op, not an error.
    s.delete("openai").unwrap();
  }

  #[test]
  fn mask_short_returns_none() {
    assert_eq!(mask_secret(""), None);
    assert_eq!(mask_secret("sk-"), None);
    assert_eq!(mask_secret("1234567"), None);
  }

  #[test]
  fn mask_normal_keeps_head_and_tail() {
    assert_eq!(mask_secret("sk-abcd1234").as_deref(), Some("sk-…1234"));
    assert_eq!(
      mask_secret("sk-ant-api03-very-long-key-XXXX1234").as_deref(),
      Some("sk-…1234"),
    );
  }

  // macOS Keychain integration test. Ignored by default because it
  // mutates the host's login keychain; run explicitly with
  // `cargo test -p agent -- --ignored keychain_roundtrip`.
  #[cfg(target_os = "macos")]
  #[test]
  #[ignore]
  fn keychain_roundtrip() {
    let store = KeyringStore::new("com.mindforest.agent.test");
    // Clean any leftover from prior runs first.
    let _ = store.delete("openai");
    assert!(store.get("openai").unwrap().is_none());
    store.set("openai", "sk-integration-test").unwrap();
    assert_eq!(
      store.get("openai").unwrap().as_deref(),
      Some("sk-integration-test"),
    );
    store.delete("openai").unwrap();
    assert!(store.get("openai").unwrap().is_none());
  }
}
