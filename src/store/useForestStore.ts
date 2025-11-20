import { create } from 'zustand';
import { produce } from 'immer'; // npm install immer
import { ForestNode, NodeID } from '@/types/forest';
import { v4 as uuidv4 } from 'uuid'; // npm install uuid @types/uuid
import { persist } from 'zustand/middleware';


interface ForestStore {
  // Data
  nodes: Record<NodeID, ForestNode>;
  rootNodeId: NodeID;
  
  // UI State
  focusedNodeId: NodeID;
  viewMode: 'tree' | 'graph';
  isSidebarOpen: boolean;

  // Actions
  setFocus: (id: NodeID) => void;
  toggleView: () => void;
  toggleSidebar: (isOpen?: boolean) => void;
  
  // CRUD
  addNode: (parentId: NodeID, title: string) => void;
  updateNodeTitle: (id: NodeID, title: string) => void;
  updateNodeContent: (id: NodeID, content: string) => void;
}

// --- Initial Mock Data ---
const INITIAL_ROOT_ID = 'root-1';
const INITIAL_NODES: Record<NodeID, ForestNode> = {
  'root-1': {
    id: 'root-1',
    parentId: null,
    title: 'My MindForest',
    content: '# Welcome\nStart mapping your mind.',
    type: 'concept',
    children: ['child-1', 'child-2'],
    links: [],
    createdAt: Date.now(),
    color: '#2d6a4f'
  },
  'child-1': {
    id: 'child-1',
    parentId: 'root-1',
    title: 'Design Patterns',
    content: '',
    type: 'concept',
    children: [],
    links: [],
    createdAt: Date.now(),
    color: '#40916c'
  },
  'child-2': {
    id: 'child-2',
    parentId: 'root-1',
    title: 'React Internals',
    content: '',
    type: 'concept',
    children: [],
    links: [],
    createdAt: Date.now(),
    color: '#40916c'
  }
};

export const useForestStore = create<ForestStore>()(
  persist(
    (set) => ({
      nodes: INITIAL_NODES,
      rootNodeId: INITIAL_ROOT_ID,
      focusedNodeId: INITIAL_ROOT_ID,
      viewMode: 'tree',
      isSidebarOpen: false,

      setFocus: (id) => set({ focusedNodeId: id }),
      
      toggleView: () => set((state) => ({ 
        viewMode: state.viewMode === 'tree' ? 'graph' : 'tree' 
      })),

      toggleSidebar: (isOpen) => set((state) => ({
        isSidebarOpen: isOpen ?? !state.isSidebarOpen
      })),

      addNode: (parentId, title) => set(produce((state: ForestStore) => {
        const newId = uuidv4();
        // 1. Create Node
        state.nodes[newId] = {
          id: newId,
          parentId,
          title,
          content: '',
          type: 'concept',
          children: [],
          links: [],
          createdAt: Date.now(),
          color: '#52b788'
        };
        // 2. Link to Parent
        if (state.nodes[parentId]) {
          state.nodes[parentId].children.push(newId);
        }
        // 3. Auto-focus new node
        state.focusedNodeId = newId;
      })),

      updateNodeTitle: (id, title) => set(produce((state: ForestStore) => {
        if (state.nodes[id]) {
          state.nodes[id].title = title;
        }
      })),

      updateNodeContent: (id, content) => set(produce((state: ForestStore) => {
        if (state.nodes[id]) {
          state.nodes[id].content = content;
        }
      })),
    }),
    {
      name: 'mindforest-storage', // unique name in localStorage
      partialize: (state) => ({ nodes: state.nodes, rootNodeId: state.rootNodeId }), // Only save data, not UI state
    }
  )
);
