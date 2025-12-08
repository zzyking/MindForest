import { create } from 'zustand';
import { produce } from 'immer';
import { persist, createJSONStorage } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';

import { ForestNode, NodeID } from '@/types/forest';
import { INITIAL_NODES, INITIAL_ROOT_ID } from './initialForest';

interface ForestDataStore {
  nodes: Record<NodeID, ForestNode>;
  rootNodeId: NodeID;
  addNode: (parentId: NodeID, title: string) => NodeID | null;
  updateNodeTitle: (id: NodeID, title: string) => void;
  updateNodeContent: (id: NodeID, content: string) => void;
  deleteNode: (id: NodeID) => NodeID | null;
  linkNodes: (sourceId: NodeID, targetId: NodeID) => void;
  unlinkNodes: (sourceId: NodeID, targetId: NodeID) => void;
}

export const useForestDataStore = create<ForestDataStore>()(
  persist(
    (set, get) => ({
      nodes: INITIAL_NODES,
      rootNodeId: INITIAL_ROOT_ID,

      addNode: (parentId, title) => {
        if (!get().nodes[parentId]) return null;
        let createdId: NodeID | null = null;

        set(
          produce((state: ForestDataStore) => {
            const newId = uuidv4();
            createdId = newId;

            state.nodes[newId] = {
              id: newId,
              parentId,
              title,
              content: '',
              type: 'concept',
              children: [],
              links: [],
              createdAt: Date.now(),
            };

            state.nodes[parentId].children.push(newId);
          })
        );

        return createdId;
      },

      updateNodeTitle: (id, title) =>
        set(
          produce((state: ForestDataStore) => {
            if (state.nodes[id]) {
              state.nodes[id].title = title;
            }
          })
        ),

      updateNodeContent: (id, content) =>
        set(
          produce((state: ForestDataStore) => {
            if (state.nodes[id]) {
              state.nodes[id].content = content;
            }
          })
        ),

      deleteNode: (id) => {
        const current = get().nodes[id];
        if (!current || id === get().rootNodeId) {
          return null;
        }

        let nextFocus: NodeID | null = current.parentId ?? get().rootNodeId;

        set(
          produce((state: ForestDataStore) => {
            if (!state.nodes[id]) return;

            if (current.parentId && state.nodes[current.parentId]) {
              state.nodes[current.parentId].children = state.nodes[current.parentId].children.filter(
                (childId) => childId !== id
              );
            }

            const idsToRemove: Set<NodeID> = new Set();
            const collect = (nodeId: NodeID) => {
              idsToRemove.add(nodeId);
              state.nodes[nodeId]?.children.forEach(collect);
            };
            collect(id);

            Object.values(state.nodes).forEach((n) => {
              n.links = n.links?.filter((linkId) => !idsToRemove.has(linkId)) ?? [];
              n.children = n.children.filter((childId) => !idsToRemove.has(childId));
            });

            idsToRemove.forEach((nodeId) => {
              delete state.nodes[nodeId];
            });
          })
        );

        return nextFocus;
      },

      linkNodes: (sourceId, targetId) =>
        set(
          produce((state: ForestDataStore) => {
            if (sourceId === targetId) return;
            const source = state.nodes[sourceId];
            const target = state.nodes[targetId];
            if (!source || !target) return;

            const ensureLink = (from: ForestNode, to: NodeID) => {
              if (!from.links.includes(to)) {
                from.links.push(to);
              }
            };

            ensureLink(source, targetId);
            ensureLink(target, sourceId);
          })
        ),

      unlinkNodes: (sourceId, targetId) =>
        set(
          produce((state: ForestDataStore) => {
            const source = state.nodes[sourceId];
            const target = state.nodes[targetId];
            if (!source || !target) return;

            source.links = source.links.filter((id) => id !== targetId);
            target.links = target.links.filter((id) => id !== sourceId);
          })
        )
    }),
    {
      name: 'mindforest-storage',
      storage: createJSONStorage(() => {
        if (typeof window === 'undefined') {
          return {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {}
          };
        }
        return window.localStorage;
      }),
      partialize: (state) => ({
        nodes: state.nodes,
        rootNodeId: state.rootNodeId
      })
    }
  )
);
