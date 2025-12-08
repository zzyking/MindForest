import { create } from 'zustand';

import { ForestNode, NodeID } from '@/types/forest';
import { INITIAL_ROOT_ID } from './initialForest';

type ViewMode = 'tree' | 'graph';
type EditorMode = 'edit' | 'preview';

interface EditorDraftState {
  nodeId: NodeID | null;
  title: string;
  content: string;
  mode: EditorMode;
  linkTargetId: string;
}

interface WorkspaceUIStore {
  focusedNodeId: NodeID;
  backStack: NodeID[];
  forwardStack: NodeID[];
  viewMode: ViewMode;
  isSidebarOpen: boolean;
  editorDraft: EditorDraftState;
  setFocus: (id: NodeID) => void;
  goToNode: (id: NodeID) => void;
  goBack: () => void;
  goForward: () => void;
  setViewMode: (mode: ViewMode) => void;
  toggleView: () => void;
  toggleSidebar: (isOpen?: boolean) => void;
  setEditorDraft: (patch: Partial<EditorDraftState>) => void;
  hydrateEditorDraft: (node: ForestNode) => void;
}

export const useWorkspaceUIStore = create<WorkspaceUIStore>((set) => ({
  focusedNodeId: INITIAL_ROOT_ID,
  backStack: [],
  forwardStack: [],
  viewMode: 'tree',
  isSidebarOpen: false,
  editorDraft: {
    nodeId: null,
    title: '',
    content: '',
    mode: 'edit',
    linkTargetId: ''
  },

  setFocus: (id) => set({ focusedNodeId: id }),
  goToNode: (id) =>
    set((state) => {
      if (state.focusedNodeId === id) return state;
      return {
        ...state,
        backStack: [...state.backStack, state.focusedNodeId],
        forwardStack: [],
        focusedNodeId: id
      };
    }),
  goBack: () =>
    set((state) => {
      if (state.backStack.length === 0) return state;
      const previous = state.backStack[state.backStack.length - 1];
      const newBack = state.backStack.slice(0, -1);
      return {
        ...state,
        focusedNodeId: previous,
        backStack: newBack,
        forwardStack: [state.focusedNodeId, ...state.forwardStack]
      };
    }),
  goForward: () =>
    set((state) => {
      if (state.forwardStack.length === 0) return state;
      const next = state.forwardStack[0];
      const newForward = state.forwardStack.slice(1);
      return {
        ...state,
        focusedNodeId: next,
        forwardStack: newForward,
        backStack: [...state.backStack, state.focusedNodeId]
      };
    }),
  setViewMode: (mode) => set({ viewMode: mode }),
  toggleView: () => set((state) => ({ viewMode: state.viewMode === 'tree' ? 'graph' : 'tree' })),
  toggleSidebar: (isOpen) => set((state) => ({ isSidebarOpen: isOpen ?? !state.isSidebarOpen })),
  setEditorDraft: (patch) =>
    set((state) => ({
      editorDraft: {
        ...state.editorDraft,
        ...patch
      }
    })),
  hydrateEditorDraft: (node) =>
    set((state) => ({
      editorDraft: {
        nodeId: node.id,
        title: node.title || '',
        content: node.content || '',
        mode: state.editorDraft.mode,
        linkTargetId: ''
      }
    }))
}));
