# Agent Harness Design

> Status: **H1 implemented + validated** (`app-core/src/context.rs`; injection 2026-06-11, live-provider validation + cosine-floor hardening 2026-07-15); **H2 implemented** (tool type layer + `ToolExecutor` over `ForestService` + OpenAI/Anthropic multi-round tool loop on `/v1/agent/propose`; SSE `tool_call_pending` / `tool_result`; UI ignores tool events until H3); H3–H4 remain design. Captures the shape of how the in-app agent should plug into the vault — what context goes in, what operations come out, how those operations land. Refer back when implementing phases H1..H4 below.
>
> H1 validation (real provider, real embeddings): the model demonstrably consumes the block — when a genuinely-related cross-topic node exists it emits a verbatim-id cross-topic `link` the single-topic node dump could never produce; when none exists it correctly declines. The gate is met. Note the marquee `<semantic-neighbors>` channel is only as good as the vault is dense: at ~25 nodes with a near-empty second topic it mostly renders empty, which is correct. The cosine floor (below) was added after validation surfaced junk nodes scoring at the ~0.58 English baseline.

## 1. Why

The agent in MindForest today is rootless. The provider sees the user's prompt and the **single** focus node's title + body, and nothing else from the vault. So it cannot:

- propose a sibling that complements the siblings already there,
- notice that the concept the user is drafting was already drafted somewhere else last month,
- cite a related node in another topic,
- move a misplaced node into the right subtree.

The output is correctly-shaped (markdown, the right node type) but never **wired** into the vault. The harness governs three things: what context the model sees, what tools it can call, how those calls land on disk. Today the first is done half-heartedly; the other two are not done at all.

## 2. Three layers

### L1 — Structural context injection

Before every model call, build a prefix that locates the focus inside the vault.

```xml
<vault-context>
  <focus topic="design-tokens" id="01HK…" type="concept" title="Color tokens">
    {first 200 chars of body}
  </focus>
  <ancestors>
    <node id="…" type="concept" title="Design system" summary="…" />
    <node id="…" type="concept" title="Visual language" summary="…" />
  </ancestors>
  <siblings>
    <node id="…" type="concept" title="Spacing tokens" />
    <node id="…" type="concept" title="Typography tokens" />
  </siblings>
  <children>
    <node id="…" type="example" title="Brand palette JSON" />
  </children>
  <links>
    <node id="…" topic="accessibility" type="fact" title="WCAG AA contrast" />
  </links>
  <semantic-neighbors>
    <node id="…" topic="rust-internals" type="concept" title="Pure-OKLCH palette generator" score="0.78" />
    …
  </semantic-neighbors>
  <recent-edits>
    <node id="…" topic="design-tokens" type="concept" title="Sand neutrals" />
  </recent-edits>
</vault-context>
```

XML-ish, not prose: providers parse the structure cleanly and the closing tags stop the "model completes an unclosed block" failure mode. Hard token budget (default **2000**, env override `MINDFOREST_AGENT_CONTEXT_BUDGET`). On overflow, drop in this order:

1. `<semantic-neighbors>` first
2. `<recent-edits>` next
3. truncate sibling / children / link entries to titles only
4. never touch `<focus>` or `<ancestors>` — those are the spine

Skip-connections are expressed via `<links>` (explicit) + `<semantic-neighbors>` (implicit). Both are needed: the user's own link choices are the strongest signal of intent, the embeddings catch what they haven't linked yet.

`<semantic-neighbors>` is **embedding-only** — a pure vector search, not the RRF-fused hybrid `search`. Fusion mixes in lexical FTS hits and reports a rank-based score that says nothing about relevance, so it can't be thresholded; a raw cosine can. Neighbors below a **cosine floor** (`MINDFOREST_AGENT_NEIGHBOR_MIN_COSINE`, default **0.60**) are dropped, and when the embedder is unavailable the section is empty rather than falling back to lexical noise. The floor matters because EmbeddingGemma-300M sits any two English passages around ~0.58, so without it a junk / near-empty node slips in and dominates a sparse vault's tiny cross-topic pool (measured: genuinely-related cross-topic node ~0.69, stub-draft junk ~0.58).

### L2 — Tool-using edits

The agent stops being a text generator and becomes an editor. Six tools, narrow on purpose:

| Tool | Args | Returns | R/W |
|---|---|---|---|
| `mf_read_node` | `id` | `Node` | R |
| `mf_search` | `query`, `k` (default 8) | `[NodeSummary]` (FTS + vec, RRF-fused) | R |
| `mf_create_node` | `parent_id`, `title`, `type`, `content` | `Node` (with newly assigned ULID) | W |
| `mf_patch_node` | `id`, `{title?, content?, type?}` | `Node` (updated) | W |
| `mf_link_nodes` | `src_id`, `dst_id` | `void` | W |
| `mf_move_subtree` | `id`, `new_parent_id` | `Node` | W |

Provider loops: `text → tool_use → tool_result → text → tool_use → … → end_turn`. Backend executes each tool against `ShadowForestService` (see §4), not directly against disk. The shadow assigns real-looking ULIDs so a later `mf_create_node` in the same turn can reference an earlier creation as its `parent_id`.

### L3 — Codebase understanding (progressive, not batch)

Two tree families, one write path. **Concept trees** are the default: the model drafts them through the L2 write tools. **Codebase trees** grow the same way — there is deliberately *no importer*. A batch import (run a pipeline, stage 2 000 nodes, ask the user to review) contradicts the product's core rule that every agent turn is a small reviewable set (`AGENT_FEATURE.md` §1). Instead, the tree grows the way understanding grows: a handful of nodes per turn, descending on demand.

One new **read-only** L2 tool makes this possible:

| Tool | Args | Returns | R/W |
|---|---|---|---|
| `mf_code_map` | `root`, `focus?` (subpath), `budget?` (tokens) | compact structural summary | R |

The summary contains: module/directory outline, key symbols ranked by degree, cross-module dependency edges each tagged `EXTRACTED` (import/call statement) or `INFERRED` (second-pass deduction), and clustering hints when available. Aggregated structure, never raw file dumps.

Interaction loop: user focuses a node, prompts "map the structure of `rust/`" → agent calls `mf_code_map` → proposes 5–8 `concept` children plus `links` for the cross-cutting dependencies (each link citing its confidence + evidence) → user reviews in the ordinary staged-diff flow → descends into one child and repeats when they want more depth. Granularity is self-regulating — the tree tracks the user's understanding, not the repo's symbol count. "Re-import" dissolves too: the tree is user-owned from the first accept; refreshing a stale subtree is just another turn (`mf_code_map` again → ordinary patch proposals).

Backends behind the one tool interface, in order:

1. **Native tree-sitter outline** (v1) — a small `code-map` crate using the mature Rust tree-sitter bindings. Start with Rust + TS/TSX: MindForest itself is the dogfood repo.
2. **graphify enhancer** (optional, never required) — if `graphify-out/graph.json` exists in the target repo, read it for richer community/edge data. We borrow graphify's essence — deterministic extraction (the model never parses code), confidence labels, aggregated summaries — and skip what doesn't fit: the batch pipeline, the Python runtime dependency, and the forced community→tree mapping (tree shape is decided by agent + user; clusters are hints).

Other source adapters (PDF, web page) follow the same shape later: a read-only summarizing tool feeding ordinary propose-review turns.

## 3. Per-turn data flow

```
focus(node X, topic T)
   │
   ▼
ContextBuilder            app-core
   reads X + ancestors + siblings + children + outgoing links via storage-fs
   embeds X.content via embed crate (cached by content hash)
   queries index-sqlite for semantic neighbors
   formats <vault-context> block, applies budget
   │
   ▼
AgentProposer.stream      agent
   system  = base_persona + <vault-context>
   tools   = [mf_read_node, mf_search, mf_create_node, …]
   │
   ▼
Tool loop in agent crate
   text chunks   ──► SSE "text"
   tool_use      ──► SSE "tool_call_pending"
                     backend dispatches to ShadowForestService
                     result   ──► back to provider as tool_result
                     also     ──► SSE "staged_diff"
   stop_reason="end_turn" ──► SSE "done"
   │
   ▼
DraftOverlay (web)
   shows assistant text + staged-diff list
   user accepts/rejects per-call or batch
   on accept ──► POST /v1/agent/staged/:turn_id/accept
                 backend replays staged writes onto real ForestService in one go
   on reject ──► POST /v1/agent/staged/:turn_id/reject  (discards shadow)
```

## 4. Decisions taken

- **Many narrow tools, not one polymorphic `apply(op)`.** Models call narrow tools more reliably across both OpenAI and Anthropic. The cost is six tool definitions instead of one; the benefit is markedly fewer malformed args.
- **Staging via shadow service.** Writes hit `ShadowForestService` (an in-memory journaling overlay that reads through to the real `ForestService`). User accept flushes the journal in one transaction; reject discards it. This is the single most important call in this doc — without staging, every agent turn risks half-applied mutations on disk.
- **Shadow assigns real ULIDs.** So `mf_create_node`'s return value is a usable `parent_id` for a later `mf_create_node` in the same turn, and the model's downstream references are stable.
- **Provider abstraction lives in the agent crate.** Tool schemas are a Rust enum with `schemars::JsonSchema` derives. `anthropic` and `openai` adapters translate to their wire format. No JSON-by-hand schema duplicated.
- **Extend existing SSE, don't add a new endpoint.** New events on `/v1/agent/propose`: `tool_call_pending`, `tool_result`, `staged_diff`. Existing `text` and `done` unchanged. Two new endpoints for staging: `/v1/agent/staged/:turn_id/{accept,reject}`.
- **No persistent memory across turns yet.** Multi-turn conversation within a single prompt (P4-LT-5) stays. Cross-prompt memory is a separate design.

## 5. Surface impact, crate by crate

| Crate / dir | Change |
|---|---|
| `rust/crates/domain` | Add `ShadowForestService` — journaling overlay; same trait shape as `ForestService`. |
| `rust/crates/embed` | Add content-hash → embedding cache. Decide in-memory LRU vs sqlite-backed after a benchmark; cold-embed under 50 ms means no cache needed. |
| `rust/crates/index-sqlite` | No new public API. ContextBuilder uses the existing `search_vec`. |
| `rust/crates/agent` | Tool-schema enum (`AgentTool` + `AgentToolInput` derives `JsonSchema`); `tool_use` in both provider adapters; new stream-event variants. |
| `rust/crates/code-map` *(new, H4)* | tree-sitter outline extraction behind the `mf_code_map` tool; optional `graphify-out/graph.json` reader. No dependency on other MindForest crates except `domain` error types. |
| `rust/crates/app-core` | New `ContextBuilder`; wire shadow + tool dispatch into the proposer flow; expose `accept_staged_turn` / `reject_staged_turn`. |
| `rust/apps/api` | Extend the SSE event vocabulary on `/v1/agent/propose`; add the two staging endpoints. |
| `web/src/lib/api.ts` + `web/src/lib/types.ts` | Mirror new SSE events and staged-diff payloads. |
| `web/src/features/agent/DraftOverlay.tsx` | "Pending changes" section: each tool call as a diff row (icon by op, title, type chip, body diff, per-call accept/reject), plus accept-all/reject-all in the footer. |

## 6. Phases

**H1 — Context only, no tools.** Ship `ContextBuilder` and inject `<vault-context>`. `AgentProposer` signature unchanged. **Validation gate**: the sibling-title test from the original plan turned out weak — the request body already dumps the whole topic (siblings included), so avoiding a collision doesn't isolate L1. The signal that *does* isolate it: with a genuinely-related node in **another** topic, the agent emits a cross-topic `link` using an id it could only have seen in `<semantic-neighbors>` (the dump is single-topic). That's the test that was run and passed (2026-07-15). If L1 alone doesn't measurably move output quality, stop — H2/H3 won't fix it either.

**H2 — Read-only tools.** Add `mf_read_node` + `mf_search`. Provider can decide to dig further. No mutations. UI unchanged — text proposals only. **Shipped** on `refactor/h2-tools`: `agent/src/tools.rs` + `app-core/src/tool_exec.rs` + provider tool loops; `AgentProposer::propose(req, tools: Option<ToolSession>)`.

**H3 — Write tools.** `mf_create_node` / `mf_patch_node` / `mf_link_nodes` / `mf_move_subtree`. Shadow service. DraftOverlay redesign for staged-diff UI. This is the largest single shipment in the harness; everything else is plumbing.

**H4 — `mf_code_map` read tool (PDF/web later).** Ship the native tree-sitter outline backend (Rust + TS/TSX first) behind the `mf_code_map` tool interface; add the optional `graphify-out/graph.json` reader as an enhancer when present. **No new UI and no importer** — codebase trees grow through the same prompt-bar → staged-diff loop as concept trees, a subtree per turn. Validation gate: point it at MindForest's own repo and grow a structure topic; the proposed `links` must cite real cross-crate dependencies with `EXTRACTED` evidence.

Don't ship H3 before H2 is real. The model gets reckless with mutations when it can't `mf_read_node` first to check what it's about to break.

## 7. Open questions

- **Persona block.** Vault-specific persona ("you are a curator for a single user who values …") or generic? Default generic, expose to `AgentSettings` later.
- **Embedding cache location.** In-memory LRU is simpler; sqlite (in `index-sqlite`) survives restarts. Benchmark first — if cold-start re-embedding the focus is under 50 ms it doesn't matter.
- **Conflict resolution.** If the user edits the focus node mid-turn, accept-on-stale must refuse. Compute content-hash on focus at turn start; recheck on accept. Show "node changed under you, re-run agent" if it diverges.
- **Cost ceiling.** Max tool calls per turn (proposal: 20). Without a ceiling a bad prompt can spiral.
- **Streaming order.** `tool_use` chunks may arrive interleaved with text. UI must keep them in narration order.
- **Tool-result verbosity.** Full `Node` payloads are big; if a turn does ten `mf_read_node`s the context bloats. May need a `mf_read_node(id, fields=[…])` variant.
- **`mf_code_map` result budget.** How much structure fits in one tool result before it crowds the turn? Proposal: default 1500-token summary with a `budget` arg; degree-ranked truncation (drop low-degree symbols first, never drop the module outline). Needs tuning against a real turn on the MindForest repo.
- **Code-map staleness.** The tool reads the repo live, but accepted tree nodes snapshot a moment in time. Cheap v1: stamp code-derived nodes with the repo's commit hash in the body footer, so "this map is from 3 weeks ago" is at least visible. Auto-detect drift is a follow-up.
- **Language rollout.** tree-sitter grammar per language is a dependency each time. Rust + TS/TSX first (dogfood), then judge demand. The graphify-enhancer path covers exotic languages in the meantime for users who have it.

## 8. Out of scope

- Multi-vault sessions
- Online retrieval (web-search tools)
- Background agent loops — agent runs only when the user prompts
- Voice input
- Cross-prompt persistent memory (separate design)
