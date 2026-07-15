/**
 * Ephemeral UI state. Slimmed down once the router took over focused-node
 * tracking — what's left is genuinely chrome-only:
 *
 * - Sidebar open/closed (persists across navigations within a session)
 * - Search palette open/closed (Cmd+K toggle)
 * - Agent settings / dock / agent bar
 * - Forest camera intent (field framing after navigation)
 *
 * Focus is URL-driven via TanStack Router (`/$topicId/$nodeId`).
 * Inspect open is URL-driven via `?w=1` — not stored here.
 *
 * For Back/Forward affordances we keep two cursors — `navBack` /
 * `navForward` — bumped by the navigation hooks.
 */

import { create } from "zustand";

import type { NodeId, TopicId } from "@/lib/types";

export type ForestCameraMode = "node" | "topic-root";

interface ForestCameraIntent {
  targetNodeId: NodeId;
  topicId: TopicId;
  mode: ForestCameraMode;
}

interface WorkspaceUIState {
  sidebarOpen: boolean;
  searchPaletteOpen: boolean;
  agentSettingsOpen: boolean;
  dockExpanded: boolean;
  /** Agent prompt bar expanded above the dock. Rest state is a dock
   *  trigger; `/` / ⌘I / the dock button open it on demand. */
  agentBarOpen: boolean;
  forestCameraIntent: ForestCameraIntent | null;
  /** Number of focus-pushes behind the current cursor (≥ 0). */
  navBack: number;
  /** Number of focus-pushes ahead of the current cursor (≥ 0). */
  navForward: number;
  toggleSidebar: () => void;
  setSidebar: (open: boolean) => void;
  toggleSearchPalette: () => void;
  setSearchPalette: (open: boolean) => void;
  setAgentSettings: (open: boolean) => void;
  toggleDock: () => void;
  expandDock: () => void;
  toggleAgentBar: () => void;
  setAgentBar: (open: boolean) => void;
  setForestCameraIntent: (intent: ForestCameraIntent | null) => void;
  consumeForestCameraIntent: (targetNodeId: NodeId, topicId: TopicId) => void;
  /** Called by `useFocusNode` when a *non-replace* push lands. */
  recordPush: () => void;
  /** Called by `useNav.back` immediately before triggering history.back. */
  recordBack: () => void;
  /** Called by `useNav.forward` immediately before triggering history.forward. */
  recordForward: () => void;
}

export const useWorkspaceUI = create<WorkspaceUIState>((set) => ({
  // Field is home — greet unobstructed. Sidebar stays reachable via ⌘\ / pill.
  sidebarOpen: false,
  searchPaletteOpen: false,
  agentSettingsOpen: false,
  dockExpanded: true,
  agentBarOpen: false,
  forestCameraIntent: null,
  navBack: 0,
  navForward: 0,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebar: (open) => set({ sidebarOpen: open }),
  toggleSearchPalette: () => set((s) => ({ searchPaletteOpen: !s.searchPaletteOpen })),
  setSearchPalette: (open) => set({ searchPaletteOpen: open }),
  setAgentSettings: (open) => set({ agentSettingsOpen: open }),
  toggleDock: () => set((s) => ({ dockExpanded: !s.dockExpanded })),
  expandDock: () => set({ dockExpanded: true }),
  toggleAgentBar: () => set((s) => ({ agentBarOpen: !s.agentBarOpen })),
  setAgentBar: (open) => set({ agentBarOpen: open }),
  setForestCameraIntent: (intent) => set({ forestCameraIntent: intent }),
  consumeForestCameraIntent: (targetNodeId, topicId) =>
    set((s) =>
      s.forestCameraIntent?.targetNodeId === targetNodeId &&
      s.forestCameraIntent.topicId === topicId
        ? { forestCameraIntent: null }
        : s,
    ),
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
