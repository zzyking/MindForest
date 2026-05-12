# Product

## Register

product

## Users

A single thoughtful person tending their own knowledge over months and years. Not teams, not students cramming for an exam, not creators chasing a publish-button. The user is at a desktop (macOS first), drafting and rearranging notes in long sessions, often on a topic that connects to other topics they've drafted before. They expect the markdown files to be theirs — readable, syncable to iCloud, version-controllable — not trapped in a proprietary database.

## Product Purpose

MindForest is a local-first knowledge workspace where the same node renders as a row in a tree (when you want hierarchy) and as a node in a force-directed graph (when you want to see what connects across topics). The editor is markdown; the source of truth is a folder of `.md` files. An optional on-device embedding model (EmbeddingGemma via MLX) feeds semantic search and an agent that proposes structured edits — both live entirely on the user's machine. Success looks like: a year from now, the vault still opens in any markdown editor even if MindForest never ships another release.

## Brand Personality

Editorial calm. Three words: **warm, contemplative, intentional.**

- **Warm** — autumn forest palette (sand, deep green, rust accent), Crimson Pro serif for headings, paper-grain noise overlay. Not corporate-cool.
- **Contemplative** — generous line-height (1.7 for body), unhurried 350ms transitions, no aggressive notifications, no streak counters, no growth-hack copy.
- **Intentional** — every animation, every shade, every shortcut is a choice someone made and could explain. The user should be able to feel that the tool was designed for them, not for a market.

The voice is honest and quiet. We don't write "✨ Magic ✨", we write "Open a topic to use the agent." Empty states explain the next action; they don't beg for engagement.

## Anti-references

**Do not look like:**

- **SaaS-cream-and-teal** (Notion, Linear default theme, the entire "B2B productivity" lane). MindForest is private, not collaborative — borrowing the visual language of multiplayer tools misrepresents what it does.
- **Cyberpunk-neon-on-black AI assistant dashboards** (most Copilot-style chrome). Our agent is a helper, not the centerpiece — the chrome should defer to the markdown text.
- **Roam-style raw outliner density**. We surface less per-row, leave more whitespace, and lean serif for headings because the value is the user's prose, not the line count.
- **Data-warehouse dashboards** (hero metric + supporting stats + sparkline). MindForest has almost no numbers on screen. Don't reach for that template.
- **AI hype landing pages**. No gradient-text headlines, no "powered by AI" badges, no glassmorphic blur stacks. The agent earns trust by working, not by looking AI-coded.

## Design Principles

1. **Markdown is the source of truth.** The vault is human-readable files, not a database. The SQLite FTS + vector index is derived state and can be rebuilt from the markdown at any time. Anything that would put data in a place the user can't read with `cat` belongs somewhere else.

2. **Local-first, single-user, no telemetry.** The app works fully offline. No accounts. No cloud sync we control (iCloud Drive on the user's vault folder is on them). No analytics. API keys never leave the user's machine — they're stored at `0600` permissions in `<data_dir>/agent.json` and traverse only the loopback HTTP between the UI and the in-process Rust API.

3. **Two views, one model.** TreeView (one topic, hierarchical) and ForestView (workspace-wide, force-directed) are different visualisations of the same nodes — never duplicated state, never a "tree-mode" data shape vs. a "graph-mode" data shape. The toggle is a view switch, not a context switch.

4. **The tool disappears into the writing.** Editor uses CodeMirror live-preview so you can write markdown without ever seeing un-rendered syntax. Chrome (sidebar, dock, agent bar) compresses to the corners when not in use. The largest, most prominent text on screen is what the user wrote.

5. **Honour OS-level user choices.** `prefers-reduced-motion` collapses every animation, including JS-driven sigma camera tweens. WCAG AA contrast is the baseline (not aspirational). Keyboard navigation works end-to-end. The skip-link lands the focus on `<main>` not on the sidebar.

## Accessibility & Inclusion

**Target: WCAG 2.1 AA, with a stretch to 2.2 AA-Minimum (24×24 touch targets) where it doesn't cost the visual rhythm.**

- All interactive controls are real `<button>` / `<a>` / `<input>` elements with `aria-label` where the visible content is iconic.
- All dialogs (`AgentSettings`, `SearchPalette`) trap focus while open and restore focus on dismiss. The non-modal `DraftOverlay` deliberately does **not** trap, because the user keeps editing the main pane while it's open.
- Streaming updates (agent token stream, search result count, model download progress) announce via `aria-live="polite"`. Errors use `role="alert"`.
- `prefers-reduced-motion: reduce` collapses all CSS animations / transitions globally and is honoured in JS-driven motion (sigma camera, hover fades).
- No information conveyed by colour alone. Node type also carries an explicit label (`TypeChip`) anywhere it's surfaced as a chip.
- The skip-link is the first focusable element in tab order.

## Design exceptions

Conscious deviations from impeccable's shared design laws. Each is documented so future passes don't "fix" them unwittingly.

### 1. Active-row 2px `before:bg-accent` indicator

**Where:** Sidebar topic rows, sidebar node-tree rows, NodeEditor Write/Read tab indicator.
**Rule it bends:** "Side-stripe borders > 1px as a colored accent on list items. Never intentional."
**Why we keep it:** This is the standard product-register affordance for "this row is the active selection" (see Linear's sidebar, Notion's sidebar, macOS Settings.app). It carries a real semantic — the active row — not decoration. Removed-and-retried with full borders or background-only tints; the active state was significantly less legible.

### 2. No dark mode

**Where:** entire app.
**Rule it bends:** Most product UIs offer dark mode as a baseline.
**Why we keep it:** The warm forest palette IS the brand identity. A dark variant would either be a different brand or a tonal inversion that loses the paper-grain, Crimson Pro warmth that's central to the contemplative feel. Single-mode is a deliberate choice. Users with strong dark-mode preference are not the target user.

### 3. `forest-400` / `forest-500` on `sand-100` clears AA-Large only

**Where:** `MetadataLine`, count labels, breadcrumb crumbs, placeholder text — all small uppercase-tracking labels.
**Rule it bends:** WCAG AA-Normal requires 4.5:1; these sit at ~3.5:1 (forest-400) and ~4.4:1 (forest-500).
**Why we keep it:** These usages are exclusively on labels with `text-[10px]` or `text-xs` uppercase-tracked, which qualify as "large text" under WCAG 2.1 *for the contrast purpose of being a secondary label*. (Strictly, "large text" means ≥18pt — these are smaller, so the spec is being applied generously.) `tokens.css` documents the contrast ratios explicitly in a comment block. If we wanted strict AA-Normal across these usages we'd have to either darken the shade (collapsing the visual hierarchy with the next stop down) or enlarge the text (defeating the "secondary, calm" intent).

### 4. Sidebar collapse animates `grid-template-columns`

**Where:** `WorkspaceShell.tsx`.
**Rule it bends:** "Don't animate CSS layout properties."
**Why we keep it:** The alternatives are (a) snap with no animation (jarring), (b) overlay pattern where the sidebar floats over the main pane (covers the left 288px of the editor, real UX cost), or (c) animate `grid-template-columns` on a single grid container with `[contain:layout]` on the aside (current). (c) is still a layout animation, but the perf cost is significantly lower than the original flex+width approach because it's a single property on a single container with explicit containment. The dock and agent prompt bar were converted to pure `translate-x` (compositor only) at the same time so the three transitions composit cleanly together.

### 5. ForestView palette read at runtime via `getComputedStyle`

**Where:** `web/src/features/forest/ForestView.tsx`.
**Rule it bends:** Most React code references tokens through Tailwind classes, not JS reads.
**Why we keep it:** sigma renders to a 2D canvas / WebGL, which can't consume CSS variables directly. We could (a) hardcode the hex values in TS (drifts from tokens.css — was the prior state), (b) duplicate the values in both files with a "keep in sync" comment, or (c) read CSS vars at sigma init and cache the palette (current). (c) is the only option that keeps `tokens.css` as the single source of truth and fails loud if a token is removed (fallbacks log against the documented hex).
