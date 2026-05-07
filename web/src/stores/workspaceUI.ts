/**
 * Ephemeral UI state. Slimmed down once the router took over focused-node
 * tracking — what's left is genuinely chrome-only:
 *
 * - Sidebar open/closed (persists across navigations within a session)
 * - Search palette open/closed (Cmd+K toggle)
 * - View mode (editor | tree | forest) — tab toggle in the dock; only
 *   meaningful when a topic is focused, but cheap to keep here so the
 *   shell can render the right pane without route-aware logic. Tree
 *   shows just the focused topic; Forest shows the whole workspace.
 *
 * Focus is URL-driven via TanStack Router (see `app/navigation.ts`).
 * For Back/Forward affordances we keep two cursors — `navBack` /
 * `navForward` — bumped by the navigation hooks. TanStack Router's
 * `BrowserHistory` doesn't expose its own cursor, so we maintain
 * counts here ourselves instead of guessing from `window.history`.
 */

import { create } from "zustand";

export type ViewMode = "editor" | "tree" | "forest";

interface WorkspaceUIState {
  sidebarOpen: boolean;
  searchPaletteOpen: boolean;
  viewMode: ViewMode;
  /** Number of focus-pushes behind the current cursor (≥ 0). */
  navBack: number;
  /** Number of focus-pushes ahead of the current cursor (≥ 0). */
  navForward: number;
  toggleSidebar: () => void;
  setSidebar: (open: boolean) => void;
  toggleSearchPalette: () => void;
  setSearchPalette: (open: boolean) => void;
  setViewMode: (mode: ViewMode) => void;
  /** Called by `useFocusNode` when a *non-replace* push lands. */
  recordPush: () => void;
  /** Called by `useNav.back` immediately before triggering history.back. */
  recordBack: () => void;
  /** Called by `useNav.forward` immediately before triggering history.forward. */
  recordForward: () => void;
}

export const useWorkspaceUI = create<WorkspaceUIState>((set) => ({
  sidebarOpen: true,
  searchPaletteOpen: false,
  viewMode: "editor",
  navBack: 0,
  navForward: 0,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebar: (open) => set({ sidebarOpen: open }),
  toggleSearchPalette: () => set((s) => ({ searchPaletteOpen: !s.searchPaletteOpen })),
  setSearchPalette: (open) => set({ searchPaletteOpen: open }),
  setViewMode: (mode) => set({ viewMode: mode }),
  // Pushing a new entry truncates the forward stack — same semantics as
  // browser history.
  recordPush: () => set((s) => ({ navBack: s.navBack + 1, navForward: 0 })),
  recordBack: () =>
    set((s) =>
      s.navBack > 0
        ? { navBack: s.navBack - 1, navForward: s.navForward + 1 }
        : s,
    ),
  recordForward: () =>
    set((s) =>
      s.navForward > 0
        ? { navBack: s.navBack + 1, navForward: s.navForward - 1 }
        : s,
    ),
}));
