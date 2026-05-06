/**
 * Ephemeral UI state. Slimmed down once the router took over focused-node
 * tracking — what's left is genuinely chrome-only:
 *
 * - Sidebar open/closed (persists across navigations within a session)
 * - Search palette open/closed (Cmd+K toggle)
 * - View mode (editor | forest) — tab toggle in the dock; only
 *   meaningful when a topic is focused, but cheap to keep here so the
 *   shell can render the right pane without route-aware logic.
 *
 * Focus + navigation state used to live here and is now URL-driven via
 * TanStack Router. See `app/navigation.ts` for the `useFocusNode` /
 * `useNav` hooks that components should call instead of importing this.
 */

import { create } from "zustand";

export type ViewMode = "editor" | "forest";

interface WorkspaceUIState {
  sidebarOpen: boolean;
  searchPaletteOpen: boolean;
  viewMode: ViewMode;
  toggleSidebar: () => void;
  setSidebar: (open: boolean) => void;
  toggleSearchPalette: () => void;
  setSearchPalette: (open: boolean) => void;
  setViewMode: (mode: ViewMode) => void;
}

export const useWorkspaceUI = create<WorkspaceUIState>((set) => ({
  sidebarOpen: true,
  searchPaletteOpen: false,
  viewMode: "editor",
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebar: (open) => set({ sidebarOpen: open }),
  toggleSearchPalette: () => set((s) => ({ searchPaletteOpen: !s.searchPaletteOpen })),
  setSearchPalette: (open) => set({ searchPaletteOpen: open }),
  setViewMode: (mode) => set({ viewMode: mode }),
}));
