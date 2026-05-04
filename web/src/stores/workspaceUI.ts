/**
 * Ephemeral UI state — *not* persisted across reloads. Workspace UI
 * always starts fresh because reproducing the in-flight focus state of
 * a previous session is more confusing than picking a sane default.
 *
 * What lives here:
 * - `focusedNodeId` — the node currently shown in the editor.
 * - `currentTopicId` — derived in handlers, but cached so the topic
 *   sidebar / breadcrumbs don't have to look it up every render.
 * - `backStack` / `forwardStack` — node-id navigation history. Behaves
 *   like a browser: focus(x) pushes to back, back() pops back into
 *   forward, focus(y) clears forward (a new branch).
 */

import { create } from "zustand";
import { produce } from "immer";

import type { NodeId, TopicId } from "@/lib/types";

interface WorkspaceUIState {
  focusedNodeId: NodeId | null;
  currentTopicId: TopicId | null;
  backStack: NodeId[];
  forwardStack: NodeId[];
  sidebarOpen: boolean;

  /** Focus a node, pushing the previous focus onto back-stack. */
  focusNode: (id: NodeId, topic?: TopicId) => void;
  /** Replace focus without touching history (used after delete). */
  setFocusReplacing: (id: NodeId | null, topic?: TopicId) => void;
  back: () => void;
  forward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;

  toggleSidebar: () => void;
  setSidebar: (open: boolean) => void;
}

export const useWorkspaceUI = create<WorkspaceUIState>((set, get) => ({
  focusedNodeId: null,
  currentTopicId: null,
  backStack: [],
  forwardStack: [],
  sidebarOpen: true,

  focusNode: (id, topic) => {
    if (get().focusedNodeId === id) return;
    set(produce((s: WorkspaceUIState) => {
      if (s.focusedNodeId) s.backStack.push(s.focusedNodeId);
      s.focusedNodeId = id;
      if (topic !== undefined) s.currentTopicId = topic;
      s.forwardStack = [];
    }));
  },

  setFocusReplacing: (id, topic) => {
    set(produce((s: WorkspaceUIState) => {
      s.focusedNodeId = id;
      if (topic !== undefined) s.currentTopicId = topic;
    }));
  },

  back: () => {
    set(produce((s: WorkspaceUIState) => {
      const prev = s.backStack.pop();
      if (prev === undefined) return;
      if (s.focusedNodeId) s.forwardStack.push(s.focusedNodeId);
      s.focusedNodeId = prev;
    }));
  },

  forward: () => {
    set(produce((s: WorkspaceUIState) => {
      const next = s.forwardStack.pop();
      if (next === undefined) return;
      if (s.focusedNodeId) s.backStack.push(s.focusedNodeId);
      s.focusedNodeId = next;
    }));
  },

  canGoBack: () => get().backStack.length > 0,
  canGoForward: () => get().forwardStack.length > 0,

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebar: (open) => set({ sidebarOpen: open }),
}));
