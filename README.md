# 🌲 MindForest

MindForest is a dual-layer visual knowledge workspace: the Tree View helps you dive deep into a topic while the Graph View exposes cross-topic relations. The app blends trees, graph canvas, and a Markdown editor so you can grow and reorganize your forest of ideas with an immersive flow.

---

## ✨ Core Features

- **Tree ↔ Graph toggle** – The bottom dock (Framer Motion) switches between `TreeLayer` (orbital layout around the focus node) and `GraphLayer` (react-force-graph-2d).
- **Node authoring panel** – `NodeEditorPanel` offers Markdown editing + preview with metadata such as created date, ID, and node type.
- **Local persistence** – Zustand with `persist` stores the forest in `localStorage`, enabling offline edits.
- **Expressive motion language** – Tailwind CSS v4 plus a custom forest palette (`src/app/globals.css`) delivers glassmorphism, glow, and film-grain accents.
- **Extensible data model** – `ForestNode` tracks both hierarchical `children` and semantic `links`, paving the way for multiple layouts and syncing strategies.

---

## 🧱 Tech Stack

- **Frontend**: Next.js 16 App Router, React 19, TypeScript  
- **State**: Zustand + Immer + uuid  
- **Animation & Canvas**: Framer Motion, react-force-graph-2d  
- **UI utilities**: Tailwind CSS 4, tailwind-merge, lucide-react, React Markdown, react-textarea-autosize

---

## 📁 Project Structure

```
src/
 ├─ app/                 # App Router (layout.tsx, page.tsx, global styles)
 ├─ components/
 │   └─ workspace/       # TreeLayer · GraphLayer · WorkspaceShell · NodeEditorPanel
 ├─ hooks/               # Shared hooks (useDebounce)
 ├─ store/               # Zustand slices (useForestStore)
 └─ types/               # Shared interfaces (forest.ts)
public/                  # Static assets & previews
```

---

## 🧭 Workspace Highlights

| Area | Description |
| --- | --- |
| `src/components/workspace/WorkspaceShell.tsx` | Client entry point that manages the dock, view toggles, sidebar animation, and layer composition. |
| `TreeLayer.tsx` | Bubble tree view that uses Framer Motion `layoutId` for seamless scaling, hover states, and parent breadcrumbs. |
| `GraphLayer.tsx` | Force-directed graph with responsive sizing, automatic focus/offset handling when the sidebar is open, and custom canvas rendering. |
| `NodeEditorPanel.tsx` | Markdown write/preview tabs, metadata panel, color chip placeholder, and delete action powered by `useDebounce`. |
| `useForestStore.ts` | Nodes CRUD, focus/view/sidebar state, Immer-based updates, and persistence. |

---

## 🚀 Getting Started

1. **Install dependencies**
   ```bash
   npm install
   # or pnpm install
   ```
2. **Local development**
   ```bash
   npm run dev
   # or pnpm dev
   ```
   Visit `http://localhost:3000` to see `WorkspaceShell`.
3. **Production build / preview**
   ```bash
   npm run build
   npm run start   # Run the prod server locally before releases
   # or pnpm build / pnpm start
   ```
4. **Quality gates**
   ```bash
   npm run lint    # ESLint + Next.js Core Web Vitals
   # or pnpm lint
   ```

> Use Node 18+ and make sure dev server, build, and lint pass before committing.

---

## 🗂️ Data & State

- `ForestNode` (`src/types/forest.ts`) keeps both `children` (tree) and `links` (graph) references; `type` currently supports `concept | fact | source | question`.
- `useForestStore` exposes:
  - `nodes`, `rootNodeId`, `focusedNodeId`, `viewMode`, `isSidebarOpen`
  - `setFocus`, `toggleView`, `toggleSidebar`
  - `addNode`, `updateNodeTitle`, `updateNodeContent`
- `persist` only saves the data layer (`nodes`, `rootNodeId`) to keep UI state predictable after refresh.

---

## 🧪 Testing & Quality

Automated tests are not committed yet. Follow the team guidelines by adding Vitest + React Testing Library suites under `src/**/__tests__` (`*.test.tsx` or `.ts`) and run:

```bash
npx vitest run --coverage
```

Document manual verification steps in PR descriptions until we consistently reach ≥80% branch coverage.

---

## 🗺️ Roadmap (excerpt)

1. **MVP**
   - Node CRUD, Tree View, focus transitions, local persistence
2. **Alpha**
   - Enhanced Graph View, accounts, cloud sync, bulletin board
3. **Beta**
   - Multiple layouts (Pythagorean / Radial / Flow), AI assistant, community features (Fork / Upvote / Learning Paths)

---

## 🤝 Contribution Guide

1. Branch from `main` and keep a clean rebase history.  
2. Write present-tense commits (e.g., `feat: expand node inspector`) and list build/lint/test status plus screenshots in PRs.  
3. Attach interaction videos or screenshots for UI work; flag breaking changes explicitly.

Let’s keep growing the MindForest together. 🌿
