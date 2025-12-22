# Changelog

## v0.1.0-alpha — 2025-12-22 — MacOS only
- Default API base is `http://127.0.0.1:8787` (Next dev on `13000`); UI waits for API health before bootstrapping.
- Remote topic bootstrap now auto-selects the first available topic or creates “My Forest”, and clears stale IDs on 404s.
- Desktop SQLite defaults to the app data directory, creates the DB file proactively, and logs the resolved path on startup.
- Tauri devtools can be opened in builds via `TAURI_DEVTOOLS=1` and the app shortcut.
- Updated packaging notes for static export into `rust-mindforest/apps/.tauri-dist`.
- Documentation now leads with the desktop app (API required), updated ports, and clearer backend/setup instructions in both READMEs.
