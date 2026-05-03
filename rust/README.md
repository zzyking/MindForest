# MindForest Rust scaffold

This subfolder contains the Rust API and desktop runtime. The Rust backend is required for the app.

## Layout
- `Cargo.toml` – Workspace config and shared dependency versions.
- `crates/domain` – Shared types (`Topic`, `KnowledgeNode`, layouts), domain errors, and a `ForestService` that owns topic/node operations.
- `crates/storage-memory` – `InMemoryForestRepository` implementing the domain repository trait with a `tokio::RwLock`.
- `crates/storage-postgres` – `SqlxForestRepository` for Postgres, storing the whole topic graph as `JSONB` for quick parity with the current data model.
- `crates/storage-sqlite` – `SqliteForestRepository` for local-first desktop builds (stores JSON in a single file).
- `apps/api` – Axum HTTP API that wires the domain service + repository and exposes topic/node endpoints.

## Running the API
```bash
cd rust-mindforest
DATABASE_URL="sqlite://$HOME/Library/Application Support/com.mindforest.desktop/mindforest.db" \
API_ADDR=127.0.0.1:8787 \
cargo run -p api
# visit http://127.0.0.1:8787/health
```

### Storage modes
- **Default (no `DATABASE_URL`)**: in-memory store, useful only for quick demos (no persistence).
- **Postgres**: set `DATABASE_URL=postgres://user:pass@host:5432/dbname` before `cargo run -p api`. On boot the app runs migrations from `apps/api/migrations` (creates `topics` table with `data JSONB`).
- **SQLite (desktop default)**: set `DATABASE_URL=sqlite://<path-to-db>` (migrations at `apps/api/migrations_sqlite`), e.g. `sqlite://$HOME/Library/Application Support/com.mindforest.desktop/mindforest.db` for desktop builds.

## Example endpoints (JSON)
- `GET  /health` – `{ "ok": true }`
- `GET  /topics` – list topics
- `POST /topics` – `{ "title": "Linear Algebra" }` → creates topic + root node
- `GET  /topics/:id` – fetch topic with nodes
- `POST /topics/:id/nodes` – `{ "title": "Eigenvalues", "parent": "<node-id>" }`
- `PATCH /topics/:id/nodes/:nodeId` – update title/content/links
- `DELETE /topics/:id/nodes/:nodeId` – remove node + its subtree

## Storage modes
- **Memory**: default when `DATABASE_URL` is unset.
- **Postgres**: set `DATABASE_URL=postgres://user:pass@host:5432/dbname` (migrations at `apps/api/migrations_postgres`).
- **SQLite**: set `DATABASE_URL=sqlite://<path-to-db>` (migrations at `apps/api/migrations_sqlite`), e.g. `sqlite://./.data/mindforest.db` for local-first desktop packaging.

## Frontend/Desktop
- The desktop app bundles this API and defaults to `127.0.0.1:8787` with SQLite at `~/Library/Application Support/com.mindforest.desktop/mindforest.db`.
- Export the Next.js app to `apps/.tauri-dist`, then `cargo tauri build` in `apps/desktop` to produce the DMG/app bundle.

## Next steps
- Harden the Postgres path: add connection pooling config, tighter indexes, and row-level auth once users exist.
- Add auth + user ownership to `Topic`.
- Generate OpenAPI/JSON Schema for the front-end and introduce a small TypeScript client.
- Desktop bundle scaffold ready (`apps/desktop`): export the Next.js app to `.tauri-dist`, then `cargo tauri build` to get the offline app using SQLite.
