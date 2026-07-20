# REFACTOR_HANDOFF — L2 (Soft bodies + morph axis)

> **Status: skeleton / not greenlit.** Do **not** implement until the human explicitly opens L2 (L1 merged + manual DoD green).  
> **Audience:** an AI agent implementing L2, plus its human reviewer.  
> **You inherit no prior conversation.** This file + the design docs are context.  
> **Authority order:** `PRODUCT_DESIGN.md` → `UI_VISION.md` → `PRODUCT.md` → `CLAUDE.md` → this file.  
> If this file seems to contradict a locked decision in those docs, **STOP and ask**.  
> **Scope of this file: L2 only.** L3–L5 are not greenlit.

**Prerequisite:** L1 landed on `refactor/v2` (or equivalent): field always home, Inspect via `?w=1`, no peer viewMode, floating sidebar, `npm run build` green.

---

## 0. Working protocol

Same discipline as L1 (`REFACTOR_HANDOFF.md` §0):

1. **First deliverable is NOT code** — understanding confirmation of §3 locks, §4 reuse, §2 landmines. Wait for nod.
2. **Phase-gated** — implement L2 only, then STOP.
3. **Commit per file-group**, not one lump.
4. **Branch:** `refactor/l2-morph` off updated `refactor/v2` (after L1 merge). Never commit onto `main` or a dirty tree.
5. **Touch only `web/src/**`.** No `rust/**`, no design-doc edits unless asked, no `~/.claude`.
6. **Gate:** `cd web && npm run build` + §6 manual checklist. No `npm test`.
7. Blocked or past a fence → **STOP and ask** (§7).

---

## 1. What L2 is (one paragraph)

Ship the **first visible morph axis** and **2.5D soft-body field language** on top of L1’s architecture:

- One continuous control labeled **近 ↔ 远** (and empty-field scroll as twin).
- **Dual-zone:** small moves = pure camera dolly (same-layer survey); past hysteresis = material + soft form change.
- Nodes read as **soft circles** with **type materials** and **static question marks** (no ambient pulse).
- Default field is **still**; motion only on growth/interaction events.
- Craft budget: **Grove (mid) readability first**, not Mist spectacle.
- **`M` does not drive morph.** Cold-open `μ` = fixed mid/Grove default.
- Inspect behavior from L1 **stays**: open snapshots `μ`, restore on close; scroll in Inspect never morphs.

L2 is **not** true layout continuum (L3), not volumetric 3D (L4), not agent ghosts (L5).

---

## 2. Landmines (carry from L1 + L2-specific)

### 2.1 From L1 — still load-bearing

- **Do not restructure `WorkspaceShell` grid/containment** for the field. Sidebar is already floating; main is full-bleed. Keep it.
- **WKWebView jitter catalogue** still applies (font-smoothing, integer strokes, `will-change-transform`, resize freezes).
- **Inspect remains URL `?w=1`**, not a store flag. Open/close only via `navigation.ts` helpers.
- **Navigate only through `useFocusNode` / `useNav` / Inspect helpers** — never raw `useNavigate` from features.

### 2.2 L2-specific

- **Do not weld scroll 1:1 to material rematerialization.** Dual-zone + throttle + ease are mandatory (critique §B①②).
- **Morph only on empty field.** Pointer over bubble / Inspect / chrome / dock → content or no-op, never `μ`.
- **No maturity auto-chase.** Even if you compute a debug `M`, it must not write `μ` continuously.
- **No ambient motion** (question pulse, aurora, breathing field). Static marks only; optional focus-only single breath if dogfood demands — default off.
- **Do not delete TreeView** (still demoted, file kept).
- **Do not rewrite NodeEditor internals** for morph — Inspect content stays L1.
- **Sigma/graphology stack:** prefer extending the existing Forest pipeline over a second WebGL home. A second engine is a **STOP-and-ask** (still open in `UI_VISION` §16).

---

## 3. Locked product/UI law (L2 must obey)

From `UI_VISION` §16 + `PRODUCT_DESIGN` §17.6–17.8 (summarized):

| Topic | Law |
|-------|-----|
| Axis | Continuous **近 ↔ 远**; form + distance coupled with **hysteresis** |
| Driver | User only; **not** node count / density |
| Cold open | Fixed mid/Grove lean |
| Inspect | Immersive center; snapshot/restore `μ`; inert bokeh |
| Motion | Default still; event-only growth |
| Question | Static hunger mark (+ Tree mark + topic open-question count when present) |
| Slider label | **近 ↔ 远** — not 雾–林 / 液–图 as primary chrome |
| Craft | Grove + ≥1 growth-action win; Mist spectacle later |
| Reduced-motion | Discrete stations (e.g. mid / far), no continuous zoom-morph |

---

## 4. Reuse map (starting point after L1)

| Fate | Surface | Notes |
|------|---------|-------|
| **Extend** | `features/forest/*` | Soft materials, radius/softness by type, static marks, event growth cues; morph driver lives near camera/sim |
| **Add (small)** | Morph chrome | Continuous slider UI — likely Dock-adjacent or field corner; **not** a peer “mode” |
| **Add (state)** | `μ` store or module | Ephemeral; **not** URL (unless later decided). Snapshot around Inspect open |
| **Keep** | Inspect / `NodePage` / `?w=1` / floating Sidebar / navigation helpers | Behavior preserved; wire freeze-μ while Inspect open |
| **Keep** | `editor/*`, agent, search | Unrelated except growth-action win if scoped |
| **Still demoted** | `TreeView` | Do not remount as peer mode |

---

## 5. L2 scope — intended work packages (to refine at greenlight)

> File list is **indicative**. At greenlight, freeze exact paths before coding (same as L1’s a–e + call-sites).

### WP-A — `μ` pipeline (invisible chrome first, then visible)

- [ ] Internal `μ ∈ [0,1]` with dual-zone mapping → camera distance + material blend.
- [ ] Empty-field wheel/pinch updates `μ` (throttled, eased).
- [ ] Inspect open: freeze `μ`; close: restore snapshot.
- [ ] Cold open: fixed default mid (document the constant).
- [ ] Reduced-motion: snap between 2 discrete stations.

### WP-B — Soft bodies (2.5D on existing field)

- [ ] Node visual: soft circle / disc; size + softness from **type** (and maybe degree cap) — **not** from vault-wide count maturity.
- [ ] `question`: static mark (tone/glyph/ring).
- [ ] Edges: near = softer/fainter; far = harder strokes (simple blend, not full L3 layout swap).
- [ ] Event motion only: accept child bud, link appear, type promotion “set” (short).

### WP-C — Visible morph slider

- [ ] Label **近 ↔ 远**; tooltip honest about distance/form, not maturity.
- [ ] Same value family as empty-field scroll (no fighting controls).
- [ ] Hidden while Inspect open (or inert); chrome stays calm.

### WP-D — Growth-action win (mandatory ≥1)

Pick **one** (or two max) for L2 — field must not only look different:

| Candidate | Idea |
|-----------|------|
| A | From field focus: one-key or one-click **add child `question`** under focus |
| B | Visible **open-question count** on topic chrome (PRODUCT_DESIGN §17.5) |
| C | Type promotion **light nudge** in Inspect (PRODUCT_DESIGN §17.2) — suggest only |

Default recommendation at greenlight: **B + A** if cheap; else **B alone**.

### Explicitly NOT in L2

- True layout continuum (family → topic → vault scope morph) — **L3**
- Metaballs / raymarched 3D resin — **L4**
- Agent spatial ghosts — **L5**
- Maturity-driven auto `μ`
- Sample vault content authoring (can parallel, not required to close L2)
- Obsidian import
- Remounting Tree as peer mode
- Shell grid resurrection for sidebar

---

## 6. Definition of Done (draft — freeze at greenlight)

**Automated**

- [ ] `cd web && npm run build` passes

**Manual**

- [ ] Slider **近↔远** moves camera and soft-form together; small moves survey without hard rematerialize pops
- [ ] Empty-field scroll == slider family; scroll over bubble/Inspect does **not** morph
- [ ] Cold open lands mid/Grove-ish, not forced empty Mist
- [ ] Inspect open freezes morph; close restores prior `μ`
- [ ] Questions scannable via static marks (no lava-lamp field)
- [ ] Default still; growth events may move briefly
- [ ] `prefers-reduced-motion`: usable discrete stations
- [ ] ≥1 growth-action win from WP-D demoed
- [ ] Dense vault still readable at 远; soft bodies don’t destroy overview
- [ ] Brand: paper resin / forest — not crypto orb (eyeball gate)
- [ ] L1 regressions: `?w=1`, Enter/Esc, field second-click, floating sidebar, no main reflow

---

## 7. STOP-and-ask

Stop before:

- Introducing a second render engine (Three.js home canvas, etc.) without approval
- Driving `μ` from node count / density / any `M`
- Ambient continuous motion
- Touching `rust/**`, `types.ts` / domain, or deleting TreeView
- Starting L3 layout continuum “while we’re here”
- Changing Inspect URL contract (`?w=1`)

---

## 8. Open decisions (resolve at greenlight, not in code)

1. **Engine path:** extend sigma node programs/shaders vs lightweight DOM/canvas soft discs vs new WebGL layer.
2. **Where slider lives:** dock row vs field bottom-center vs corner stack.
3. **WP-D growth win:** which one(s).
4. **Persist `μ`?** session-only vs per-topic memory (default lean: session-only).
5. **Material probe pack:** do we require a static probe page before L2 merge, or only before L4?

---

## 9. Suggested greenlight checklist (human)

Before saying “implement L2”:

- [ ] L1 merged to `refactor/v2`
- [ ] L1 manual DoD accepted (incl. long-form / Zen decision)
- [ ] §8 open decisions answered (at least 1–3)
- [ ] This file’s WP file list frozen into concrete paths
- [ ] Branch name confirmed: `refactor/l2-morph`

---

## 10. Pointers

| Doc | Use for |
|-----|---------|
| `UI_VISION.md` §3, §4, §5, §14 L2, §16 | Morph law, materials, phases |
| `PRODUCT_DESIGN.md` §7, §17.6–17.8 | Product locks, growth loop |
| `PRODUCT.md` | Brand, a11y, motion calm |
| `CLAUDE.md` | Stores, routes, build |
| `REFACTOR_HANDOFF.md` (L1) | Protocol template; L1 landmines |

---

## 11. One-line brief

**L2 makes the field speak type and distance: soft bodies + a dual-zone 近↔远 axis the user owns — without maturity theater, ambient motion, or abandoning L1’s Inspect/field shell.**
