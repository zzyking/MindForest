# Agent in the App — Feature Design

> Status: design proposal. The product-side counterpart to `AGENT_HARNESS.md` (which covers context injection, tool schema, staging, SSE protocol). This doc says **what the user sees**: where the agent shows up, what it can be asked to do, how proposals are reviewed, what's in settings, and what behaviors are forbidden by design.

## 1. Role

The agent in MindForest is not a chat companion. It is a **junior knowledge worker** — a draft hand that takes a small instruction at the focus node, produces a concrete reviewable set of edits, and stops. The user is the editor; the agent is the assistant.

That framing rules out:

- chat-only "ask me anything" with no edits
- the agent typing freely into the user's document
- background agent loops that act without a prompt

And rules in:

- the agent always proposes; the user always applies
- every proposal is reviewable, atomic, and reversible
- silence is the default — most of a session, the agent isn't on

## 2. Where the agent appears

Five surfaces, ranked by expected use:

1. **Prompt bar (bottom-center).** Main entry. `/` or `Cmd+I` to focus, type, Enter. Bar always reflects the focus node. Bar contracts to a glyph + status while streaming; expands back on completion.
2. **DraftOverlay (right-side panel).** Slides in when a turn starts. Streams text top, staged-edit list bottom, per-edit accept/reject + accept-all/reject-all. Stays open until dismissed so the user has time to review.
3. **Per-node "ask" affordances.** On the focused node card, a spark-icon button offers one-shot starters ("explain this", "add a child", "find related"). Each pre-fills the prompt bar — same input path, no special UI.
4. **Inline suggestions inside the editor.** Ghost-text completions while writing; Tab to accept. Lower priority — ships after H3.
5. **Settings (`Cmd+,`).** Provider, model, persona, context budget, auto-accept policies, activity log (later).

## 3. What the agent can be asked to do

Five task categories. Same prompt bar drives all of them; the agent picks the right tools from the instruction. There is no per-task UI mode.

| Category | Example | Tools used | Output surface |
|---|---|---|---|
| **Expand** | "draft children for this concept" | `mf_create_node` × N | diff cards |
| **Refine** | "tighten this body to 200 chars" | `mf_patch_node` | diff card with body diff |
| **Connect** | "what else in the vault relates to this?" | `mf_search` + `mf_link_nodes` | proposed links + cited snippets |
| **Restructure** | "this is in the wrong topic — move it" | `mf_move_subtree` (+ patches) | diff card with from→to path preview |
| **Investigate** | "summarize this subtree" / "X vs Y?" | `mf_read_node` + `mf_search` (read-only) | streamed prose, no diff |

Codebase trees are not a sixth category — they ride **Expand** ("map the structure of `rust/`") and **Investigate** ("how does the embed pipeline work?") with one extra read-only tool, `mf_code_map` (see `AGENT_HARNESS.md` §L3). Same prompt bar, same staged-diff review, a subtree per turn. There is no bulk import surface anywhere in the product.

## 4. Interaction shape

### Single-turn flow

```
focus a node
  │
  ▼
type instruction in prompt bar  →  Send
  │
  ▼
overlay opens, streaming begins
  │
  ▼
text appears top                 diff cards land bottom as tools fire
  │                                       │
  └─────────── stream ends ───────────────┘
  │
  ▼
user reviews:
  ├─ accept all     → backend transacts all staged writes at once
  ├─ reject all     → backend discards the shadow
  └─ per-card       → flushes only the accepted cards (in order)
  │
  ▼
overlay shows post-accept summary ("3 of 5 applied"), Done button
```

### Multi-turn

After a turn ends the overlay stays open. The prompt bar refocuses. The user can:

- send a follow-up — the agent sees the prior turn's text + the new instruction
- accept/reject staged edits from the prior turn at any time
- say "no, do it differently" — the prior staged set becomes discardable context, not facts on disk

Sessions are bounded by an explicit **Reset** button in the overlay header (or closing the overlay). Reset clears history + the shadow.

### Error states

| State | Behavior |
|---|---|
| Stream stalls > 10 s with no tokens | overlay shows "Waiting on model…" hint; cancel button |
| Provider returns an error | surfaced inline in the overlay (not a toast — too easy to miss) |
| Tool call rejected by `ForestService` validation | proposal marked **failed** with the reason; user can skip or follow up |
| Accept fails (node changed under user) | proposal marked **failed**; prompt to re-run on fresh state |
| Cancel mid-stream | partial draft preserved for context; staged shadow discarded |

### Empty states

- No vault content yet → bar hint: *"create a topic first to give the agent something to work with"*
- Provider not configured → bar disabled; nudge into AgentSettings
- Local-only mode (future) → bar shows an "on device" badge

## 5. Trust and review affordances

Reviewability is the central design constraint. Every staged edit must communicate, at a glance:

- **What kind of change.** Icon: ➕ create / ✏️ patch / 🔗 link / ➡️ move.
- **What node.** Title + type chip + topic (badge when cross-topic).
- **What changes.** For `patch`, a body diff (red strike-out + green added); for `create`, full proposed body; for `link`, the two endpoints; for `move`, the from→to subtree path.
- **Why.** Optional one-line rationale the model attaches via tool_use input. Show it under the title in dim type.

Accept rules:

- **Default**: per-card accept.
- **Accept-all** is available, but gated by an inline confirm when the staged set has > 5 cards or contains any `mf_move_subtree`.
- **Auto-accept** is opt-in per-operation in settings (e.g. "always auto-link semantic neighbors above score 0.85").

Reject rules:

- Reject is non-destructive — the staged work is lost, the vault is untouched.
- **"Reject and tell me why"** opens a feedback box; the feedback pre-fills the prompt bar for a follow-up turn.

## 6. Settings

Lives under `Cmd+,` (AgentSettings panel). Three sections + a future fourth.

### Provider & model

- Provider: Anthropic / OpenAI / OpenAI-compatible / Stub
- Model: dropdown with sensible defaults, freeform override
- API key: Keychain-backed masked field (already shipped via K-1..K-5)
- Base URL: for OpenAI-compat endpoints (local llama.cpp, vLLM, etc.)

### Behavior

- **Persona**: textarea, sets voice. Optional; default empty.
- **Context budget**: 500..4000 tokens, default 2000.
- **Max tool calls per turn**: default 20, hard cap 50.
- **Recent-edits window**: how many recently-touched nodes feed `<recent-edits>` context (default 5).

### Auto-accept policies

- Semantic-neighbor `mf_link_nodes` over score X → auto-link (default: off, suggested 0.85)
- `mf_patch_node` with title-only change → auto-apply (default: off)
- Everything else: always staged

### Activity log (future)

- Per-turn log: timestamp, prompt, tools called, accept/reject outcome
- "Replay this turn" / "use this prompt again"
- JSON export for debugging

## 7. Behaviors the agent must not exhibit

Hard rules. Enforced at the harness layer (see `AGENT_HARNESS.md` §4 & §7), surfaced as guarantees here:

- Never write to disk before user accept (shadow staging is the mechanism).
- Never read or write outside the active vault.
- Never call a tool more than the per-turn cap.
- Never propose `delete`. Deletes are user-initiated only — an explicit safety boundary.
- Never include the focus node's own body in `<semantic-neighbors>` (causes self-referential RAG loops).
- Never invent ULIDs. All IDs come from `mf_search` / `mf_read_node` results or the shadow's `mf_create_node` returns.

## 8. Out of scope for the first cut

- Voice prompt
- Agent-to-agent review (one agent grading another's proposals)
- Scheduled / background agent runs ("every Sunday, summarize the week")
- Persistent cross-prompt memory (separate design — see open Q in harness doc)
- Multi-vault context

## 9. Long-term shape

Where this should converge over the next year:

- **On-device by default.** Same Swift-sidecar pattern that powers embeddings; a local Llama-class model handles routine tasks. Cloud providers used only when the user explicitly opts in for a better model on a specific turn.
- **Logged and replayable.** Every turn lives in an audit log: prompt + tools + outcome + rationale. The user can replay any past turn against fresh focus.
- **Stylistically transparent.** The agent's voice (title casing, prose rhythm, type choices) is constrained by a content-side equivalent of `DESIGN.md` — so the vault stays consistent across human + agent contributions.

That last point is the ambition: a year from now, skimming the vault, you shouldn't be able to tell which nodes the agent drafted and which you did — except where the rationale log says so.
