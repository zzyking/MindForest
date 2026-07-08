---
name: verify
description: Runtime verification recipe for the MindForest web frontend (web/) — build/launch/drive the SPA against the real Rust API and observe behavior in a real browser.
---

# Verify the web frontend (runtime observation)

The frontend has no test runner (`npm test` doesn't exist). The lint gate
is `npm run build` (`tsc -b --noEmit && vite build`) — that is a
type-check, NOT verification. To verify a UI change you must run the app
and drive it.

## 1. Bring up the two servers

The SPA needs the Rust API. From repo root:

```bash
VAULT="$HOME/Library/Application Support/com.mindforest.desktop/vault"
MINDFOREST_VAULT="$VAULT" API_ADDR=127.0.0.1:8787 \
  cargo run --manifest-path rust/Cargo.toml -p api > /tmp/mf-api.log 2>&1 &
# poll until ready:
until curl -sf -m2 http://127.0.0.1:8787/health >/dev/null; do sleep 1; done

cd web && npm run dev > /tmp/mf-vite.log 2>&1 &   # serves http://localhost:13000
```

Note: `cargo run` spawns the `api` binary as a child; the parent may
report exit 0 while the binary keeps listening on :8787. Check the port,
not the cargo exit code. Kill servers when done:
`lsof -tiTCP:8787,13000 -sTCP:LISTEN | xargs kill`.

## 2. Drive a real browser

The Playwright MCP server is hard-configured to channel `chrome`, which
isn't installed here and needs sudo to install. **Workaround:** the
cached Chromium (`~/Library/Caches/ms-playwright/chromium-*`) works when
driven from a standalone node script:

```js
import pkg from '/Users/king/node_modules/playwright/index.js'; // CJS: default-import
const { chromium } = pkg;
const browser = await chromium.launch({ headless: true });
```
Run with `PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright" node script.mjs`.

## 3. Testing at scale without mutating the vault

The real vault is small (~27 nodes). To exercise large-list behavior
(virtualization, windowing), intercept the API with `page.route` and
inject synthetic data — do NOT write to the vault.

Two gotchas that will silently produce an empty UI:
- **Use a regex matcher, not a glob.** `page.route(/\/v1\/topics/, ...)`
  works; `page.route('**/v1/topics**', ...)` did not match and requests
  fell through / hung.
- **Fulfilled responses need CORS headers.** :13000→:8787 is
  cross-origin; add `{ 'access-control-allow-origin': '*' }` to every
  `route.fulfill`, or the browser blocks your mock and the store shows
  empty + retries.

Wire shapes to mock live in `web/src/lib/types.ts`
(`TopicSummary`, `TopicDetail`, `NodeSummary`). Unrelated calls
(`/v1/nodes/:id`) will 400 for synthetic ids — expected noise, ignore.

## 4. What to observe

Screenshot + assert on the DOM. For the sidebar node tree
(`web/src/ui/Sidebar.tsx`), useful signals: `[role="tree"]` sized-spacer
height, count of mounted `[role="treeitem"]` vs total nodes (should stay
~viewport+overscan when virtualized), row-rect contiguity (max inter-row
gap ≈ 0 proves indent guides connect), and mounted-row sets at two
scroll offsets being disjoint (proves off-screen rows unmount).
