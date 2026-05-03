# MindForest Desktop (Tauri + Axum + SQLite)

This scaffold wraps the Rust API and a static Next.js export into a desktop app with local SQLite storage.

## Build steps
1) Export the Next.js frontend to static assets (from repo root):
```bash
npm run build
rm -rf rust-mindforest/apps/.tauri-dist
mkdir -p rust-mindforest/apps/.tauri-dist
cp -R out/* rust-mindforest/apps/.tauri-dist   # Next 16 static export writes to out/
```

2) Build the Tauri app:
```bash
cd rust-mindforest/apps/desktop
cargo tauri build     # or cargo tauri dev for live dev (devUrl=http://localhost:13000)
```

## How it works
- On startup, Tauri spawns the Axum API in-process on `127.0.0.1:8787`.
- The API uses SQLite at `sqlite://${HOME}/Library/Application Support/com.mindforest.desktop/mindforest.db` by default (or your `DATABASE_URL` if set). On launch the app logs the resolved path to stdout.
- The frontend (file-based assets from `.tauri-dist`) calls the API at `http://127.0.0.1:8787`.

## Configuration
- API port: override with `API_ADDR` env (e.g., `API_ADDR=127.0.0.1:9000 cargo tauri dev`).
- Database: default `sqlite://${HOME}/Library/Application Support/com.mindforest.desktop/mindforest.db`; override with `DATABASE_URL=sqlite://...` if you want a custom path.
- Static files: adjust `tauri.conf.json` `distDir` if you export to a different folder.
- DevTools: run with `TAURI_DEVTOOLS=1 cargo tauri dev` (or on the built app) then `⌥+⌘+I` to open.
- macOS Gatekeeper: if the unsigned app is reported “damaged”, remove quarantine via `xattr -dr com.apple.quarantine /Applications/MindForest.app` (or on the DMG before mounting).
