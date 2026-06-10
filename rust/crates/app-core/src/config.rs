//! Agent config persistence — `agent.json` on disk + API keys in the
//! OS keychain.
//!
//! The JSON file carries provider/model/base-url settings; the keychain
//! (`SecretStore`) is the only durable home for API keys. The plaintext
//! `api_key` fields on `AgentConfig` are an in-memory view hydrated at
//! load time and written through on save — they are `skip_serializing`
//! so they never land in the file.

use std::sync::Arc;

use agent::{secret_accounts, AgentConfig, SecretStore, SECRET_SERVICE};

/// Read `agent.json` from disk and hydrate API keys from the SecretStore.
///
/// Behavior:
/// 1. Read the JSON file (missing/malformed → defaults, fail soft —
///    don't brick the app over a broken settings file).
/// 2. If the JSON contains legacy plaintext `api_key` fields (pre-keychain
///    installs), migrate them into the SecretStore.
/// 3. For each provider with no key already in memory, pull from the
///    SecretStore.
/// 4. If anything was migrated, rewrite the file atomically so the
///    plaintext is gone on the next boot — old keys never linger on
///    disk after they've been moved to the keychain.
pub(crate) async fn load_and_hydrate_agent_config(
  path: &std::path::Path,
  secret_store: &Arc<dyn SecretStore>,
) -> AgentConfig {
  let bytes = match tokio::fs::read(path).await {
    Ok(b) => b,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
      // No file yet — still hydrate from keychain so a user who set
      // keys on a prior install gets them back even after `agent.json`
      // is deleted.
      let mut cfg = AgentConfig::default();
      hydrate_secrets(&mut cfg, secret_store);
      return cfg;
    }
    Err(e) => {
      tracing::warn!("agent config read failed at {path:?}: {e}; using defaults");
      return AgentConfig::default();
    }
  };
  let mut cfg = match serde_json::from_slice::<AgentConfig>(&bytes) {
    Ok(c) => c,
    Err(e) => {
      tracing::warn!("agent config parse failed at {path:?}: {e}; using defaults");
      AgentConfig::default()
    }
  };

  // Step 2 — migrate any legacy plaintext keys.
  let mut migrated = false;
  if let Some(k) = cfg.openai.api_key.as_deref() {
    if !k.is_empty() {
      if let Err(e) = secret_store.set(secret_accounts::OPENAI, k) {
        tracing::warn!("migrate openai api_key into keychain failed: {e}");
      } else {
        migrated = true;
      }
    }
  }
  if let Some(k) = cfg.anthropic.api_key.as_deref() {
    if !k.is_empty() {
      if let Err(e) = secret_store.set(secret_accounts::ANTHROPIC, k) {
        tracing::warn!("migrate anthropic api_key into keychain failed: {e}");
      } else {
        migrated = true;
      }
    }
  }

  // Step 3 — for providers without an in-memory key, read from keychain.
  hydrate_secrets(&mut cfg, secret_store);

  // Step 4 — rewrite the file so plaintext keys are wiped.
  if migrated {
    tracing::info!(
      "migrated legacy plaintext agent api_key(s) from {path:?} into the OS keychain ({}). \
       The file has been rewritten without secrets.",
      SECRET_SERVICE
    );
    if let Err(e) = write_agent_config_file(path, &cfg).await {
      tracing::warn!("failed to rewrite agent.json after migration: {e}");
    }
  }

  cfg
}

/// Pull `api_key`s from the SecretStore into the in-memory config for
/// any provider that doesn't already have one. Errors are logged and
/// swallowed — a keychain access failure shouldn't take the agent path
/// down; the user will see an empty `api_key` in the settings UI and
/// can re-enter.
fn hydrate_secrets(cfg: &mut AgentConfig, secret_store: &Arc<dyn SecretStore>) {
  if cfg.openai.api_key.as_deref().unwrap_or("").is_empty() {
    match secret_store.get(secret_accounts::OPENAI) {
      Ok(Some(k)) => cfg.openai.api_key = Some(k),
      Ok(None) => {}
      Err(e) => tracing::warn!("read openai api_key from keychain failed: {e}"),
    }
  }
  if cfg.anthropic.api_key.as_deref().unwrap_or("").is_empty() {
    match secret_store.get(secret_accounts::ANTHROPIC) {
      Ok(Some(k)) => cfg.anthropic.api_key = Some(k),
      Ok(None) => {}
      Err(e) => tracing::warn!("read anthropic api_key from keychain failed: {e}"),
    }
  }
}

/// Atomic-ish write of `agent.json`. Shared between the initial migration
/// path and the runtime `set_agent_config` path. Writes to a sibling
/// `.tmp` then renames, so a crash mid-write can't leave a truncated
/// file. Sets 0600 on unix.
pub(crate) async fn write_agent_config_file(
  path: &std::path::Path,
  config: &AgentConfig,
) -> Result<(), String> {
  let bytes =
    serde_json::to_vec_pretty(config).map_err(|e| format!("serialize agent config: {e}"))?;
  if let Some(parent) = path.parent() {
    tokio::fs::create_dir_all(parent)
      .await
      .map_err(|e| format!("create {parent:?}: {e}"))?;
  }
  let tmp = path.with_extension("json.tmp");
  tokio::fs::write(&tmp, &bytes)
    .await
    .map_err(|e| format!("write {tmp:?}: {e}"))?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let _ = tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).await;
  }
  tokio::fs::rename(&tmp, path)
    .await
    .map_err(|e| format!("rename {tmp:?}→{path:?}: {e}"))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use agent::InMemoryStore;
  use tempfile::TempDir;

  #[tokio::test]
  async fn legacy_plaintext_api_key_migrates_into_keychain() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("agent.json");
    // Pre-keychain build: api_key sits in the JSON in plaintext.
    let legacy = serde_json::json!({
      "provider": "openai",
      "openai": { "base_url": "https://api.openai.com/v1", "model": "gpt-4o-mini", "api_key": "sk-legacy-abcd1234" },
      "anthropic": { "model": "claude-sonnet-4-6", "api_key": null }
    });
    tokio::fs::write(&path, serde_json::to_vec_pretty(&legacy).unwrap())
      .await
      .unwrap();

    let store: Arc<dyn SecretStore> = Arc::new(InMemoryStore::new());
    let cfg = load_and_hydrate_agent_config(&path, &store).await;

    // In-memory state still carries the key (so the proposer can build).
    assert_eq!(cfg.openai.api_key.as_deref(), Some("sk-legacy-abcd1234"));
    // SecretStore got it.
    assert_eq!(
      store.get(secret_accounts::OPENAI).unwrap().as_deref(),
      Some("sk-legacy-abcd1234"),
    );
    // File was rewritten without the plaintext field.
    let rewritten: serde_json::Value =
      serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
    assert!(rewritten.get("openai").unwrap().get("api_key").is_none());
  }

  #[tokio::test]
  async fn missing_agent_json_hydrates_from_keychain() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("agent.json"); // not created
    let store: Arc<dyn SecretStore> = Arc::new(InMemoryStore::new());
    store
      .set(secret_accounts::ANTHROPIC, "sk-ant-from-store")
      .unwrap();
    let cfg = load_and_hydrate_agent_config(&path, &store).await;
    assert_eq!(cfg.anthropic.api_key.as_deref(), Some("sk-ant-from-store"));
  }
}
