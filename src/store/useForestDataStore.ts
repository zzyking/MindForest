import { create } from 'zustand';
import { produce } from 'immer';
import { persist, createJSONStorage } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';

import { api, Topic as ApiTopic } from '@/lib/api';
import { ForestNode, NodeID } from '@/types/forest';
import { INITIAL_NODES, INITIAL_ROOT_ID } from './initialForest';

interface ForestDataStore {
  nodes: Record<NodeID, ForestNode>;
  rootNodeId: NodeID;
  remoteTopicId: string | null;
  setRemoteTopicId: (id: string | null) => void;
  ensureRemoteTopic: () => Promise<NodeID | null>;
  loadRemoteTopic: (topicId?: string) => Promise<NodeID | null>;
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
      remoteTopicId: null,

      setRemoteTopicId: (id) => set({ remoteTopicId: id }),

      ensureRemoteTopic: async () => {
        // If we already have one, try to load it; on failure, clear and continue
        const existing = get().remoteTopicId;
        if (existing) {
          const loaded = await get().loadRemoteTopic(existing);
          if (loaded) return loaded;
          set({ remoteTopicId: null });
        }

        try {
          await waitForApi();
          // Prefer an existing topic on the server
          const topics = await api.listTopics();
          if (topics.length > 0) {
            const firstId = topics[0].id;
            set({ remoteTopicId: firstId });
            return get().loadRemoteTopic(firstId);
          }

          // Otherwise create a default one
          const created = await api.createTopic({ title: 'My Forest' });
          const next = mapTopicToState(created);
          set({
            nodes: next.nodes,
            rootNodeId: next.rootNodeId,
            remoteTopicId: created.id
          });
          return next.rootNodeId;
        } catch (err) {
          console.error('Failed to ensure remote topic', err);
          return null;
        }
      },

      loadRemoteTopic: async (topicId) => {
        const resolvedId = topicId ?? get().remoteTopicId;
        if (!resolvedId) return null;
        try {
          const topic = await api.getTopic(resolvedId);
          const nextState = mapTopicToState(topic);
          set({
            nodes: nextState.nodes,
            rootNodeId: nextState.rootNodeId,
            remoteTopicId: resolvedId
          });
          return nextState.rootNodeId;
        } catch (err) {
          console.error('Failed to load remote topic', err);
          set({ remoteTopicId: null });
          return null;
        }
      },

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

        if (createdId && get().remoteTopicId) {
          const topicId = get().remoteTopicId!;
          void api
            .addNode(topicId, { id: createdId, parent: parentId, title })
            .then((topic) => {
              const next = mapTopicToState(topic);
              set({ nodes: next.nodes, rootNodeId: next.rootNodeId });
            })
            .catch((err) => console.error('Failed to sync addNode', err));
        }

        return createdId;
      },

      updateNodeTitle: (id, title) => {
        set(
          produce((state: ForestDataStore) => {
            if (state.nodes[id]) {
              state.nodes[id].title = title;
            }
          })
        );

        const topicId = get().remoteTopicId;
        if (topicId && get().nodes[id]) {
          void api
            .updateNode(topicId, id, { title })
            .then((topic) => {
              const next = mapTopicToState(topic);
              set({ nodes: next.nodes, rootNodeId: next.rootNodeId });
            })
            .catch((err) => console.error('Failed to sync title', err));
        }
      },

      updateNodeContent: (id, content) => {
        set(
          produce((state: ForestDataStore) => {
            if (state.nodes[id]) {
              state.nodes[id].content = content;
            }
          })
        );

        const topicId = get().remoteTopicId;
        if (topicId && get().nodes[id]) {
          void api
            .updateNode(topicId, id, { content })
            .then((topic) => {
              const next = mapTopicToState(topic);
              set({ nodes: next.nodes, rootNodeId: next.rootNodeId });
            })
            .catch((err) => console.error('Failed to sync content', err));
        }
      },

      deleteNode: (id) => {
        const current = get().nodes[id];
        if (!current || id === get().rootNodeId) {
          return null;
        }

        const nextFocus: NodeID | null = current.parentId ?? get().rootNodeId;

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

        if (get().remoteTopicId) {
          const topicId = get().remoteTopicId!;
          void api
            .deleteNode(topicId, id)
            .then((topic) => {
              const next = mapTopicToState(topic);
              set({ nodes: next.nodes, rootNodeId: next.rootNodeId });
            })
            .catch((err) => console.error('Failed to sync deleteNode', err));
        }

        return nextFocus;
      },

      linkNodes: (sourceId, targetId) => {
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
        );

        const topicId = get().remoteTopicId;
        if (topicId) {
          const source = get().nodes[sourceId];
          const target = get().nodes[targetId];
          if (source && target) {
            const syncNode = (nodeId: NodeID, links: NodeID[]) =>
              api.updateNode(topicId, nodeId, { links }).catch((err) =>
                console.error('Failed to sync links', err)
              );

            void Promise.all([syncNode(sourceId, source.links), syncNode(targetId, target.links)])
              .then(() => api.getTopic(topicId))
              .then((topic) => {
                const next = mapTopicToState(topic);
                set({ nodes: next.nodes, rootNodeId: next.rootNodeId });
              })
              .catch((err) => console.error('Failed to refresh links after sync', err));
          }
        }
      },

      unlinkNodes: (sourceId, targetId) => {
        set(
          produce((state: ForestDataStore) => {
            const source = state.nodes[sourceId];
            const target = state.nodes[targetId];
            if (!source || !target) return;

            source.links = source.links.filter((id) => id !== targetId);
            target.links = target.links.filter((id) => id !== sourceId);
          })
        );

        const topicId = get().remoteTopicId;
        if (topicId) {
          const source = get().nodes[sourceId];
          const target = get().nodes[targetId];
          if (source && target) {
            const syncNode = (nodeId: NodeID, links: NodeID[]) =>
              api.updateNode(topicId, nodeId, { links }).catch((err) =>
                console.error('Failed to sync links', err)
              );

            void Promise.all([syncNode(sourceId, source.links), syncNode(targetId, target.links)])
              .then(() => api.getTopic(topicId))
              .then((topic) => {
                const next = mapTopicToState(topic);
                set({ nodes: next.nodes, rootNodeId: next.rootNodeId });
              })
              .catch((err) => console.error('Failed to refresh links after sync', err));
          }
        }
      }
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
        rootNodeId: state.rootNodeId,
        remoteTopicId: state.remoteTopicId
      })
    }
  )
);

function mapTopicToState(topic: ApiTopic): { nodes: Record<NodeID, ForestNode>; rootNodeId: NodeID } {
  const mapped: Record<NodeID, ForestNode> = {};
  Object.values(topic.nodes).forEach((node) => {
    mapped[node.id] = {
      id: node.id,
      parentId: node.parent,
      title: node.title,
      content: node.content,
      type: node.metadata.node_type,
      children: node.children,
      links: node.links,
      createdAt: node.metadata.created_at
    };
  });
  return { nodes: mapped, rootNodeId: topic.root_node_id };
}

async function waitForApi(maxAttempts = 10, delayMs = 500): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await api.health();
      if (res.ok) return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
