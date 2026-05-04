/**
 * Ephemeral UI state. Slimmed down once the router took over focused-node
 * tracking — what's left is genuinely chrome-only:
 *
 * - Sidebar open/closed (persists across navigations within a session)
 * - Search palette open/closed (Cmd+K toggle)
 *
 * Focus + navigation state used to live here and is now URL-driven via
 * TanStack Router. See `app/navigation.ts` for the `useFocusNode` /
 * `useNav` hooks that components should call instead of importing this.
 */

import { create } from "zustand";

interface WorkspaceUIState {
  sidebarOpen: boolean;
  searchPaletteOpen: boolean;
  toggleSidebar: () => void;
  setSidebar: (open: boolean) => void;
  toggleSearchPalette: () => void;
  setSearchPalette: (open: boolean) => void;
}

export const useWorkspaceUI = create<WorkspaceUIState>((set) => ({
  sidebarOpen: true,
  searchPaletteOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebar: (open) => set({ sidebarOpen: open }),
  toggleSearchPalette: () => set((s) => ({ searchPaletteOpen: !s.searchPaletteOpen })),
  setSearchPalette: (open) => set({ searchPaletteOpen: open }),
}));
