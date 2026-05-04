/**
 * Authoritative client-side mirror of the vault.
 *
 * Pattern (carried over from v1 with one important change):
 * - Local mutations are **optimistic** — we patch the in-memory map
 *   immediately so the UI doesn't wait on a network round trip — and
 *   then reconcile against the server's response. Failed PATCH/DELETE
 *   reverts the optimistic change and surfaces the error.
 * - Unlike v1, the server is the source of truth for `updated_at` and
 *   any computed fields, so the reconcile step replaces the entire
 *   node record. Don't read fields out of `pending`-state nodes.
 */

import { create } from "zustand";
import { produce } from "immer";

import * as api from "@/lib/api";
import type {
  NewNode,
  Node,
  NodeId,
  NodePatch,
  Topic,
  TopicDetail,
  TopicId,
  TopicSummary,
} from "@/lib/types";

interface ForestDataState {
  // server mirror
  topics: Record<TopicId, TopicSummary>;
  topicDetails: Record<TopicId, TopicDetail>;
  nodes: Record<NodeId, Node>;
  // load state per resource
  loading: {
    topics: boolean;
    topicDetail: Record<TopicId, boolean>;
    node: Record<NodeId, boolean>;
  };
  // last error per resource (cleared on success)
  errors: {
    topics: string | null;
    topicDetail: Record<TopicId, string | null>;
    node: Record<NodeId, string | null>;
  };

  // actions
  fetchTopics: () => Promise<void>;
  fetchTopic: (id: TopicId) => Promise<TopicDetail>;
  fetchNode: (id: NodeId) => Promise<Node>;
  createTopic: (title: string) => Promise<Topic>;
  createNode: (input: NewNode) => Promise<Node>;
  patchNode: (id: NodeId, patch: NodePatch) => Promise<Node>;
  deleteNode: (id: NodeId) => Promise<void>;
}

export const useForestData = create<ForestDataState>((set, get) => ({
  topics: {},
  topicDetails: {},
  nodes: {},
  loading: { topics: false, topicDetail: {}, node: {} },
  errors: { topics: null, topicDetail: {}, node: {} },

  fetchTopics: async () => {
    set(produce((s: ForestDataState) => {
      s.loading.topics = true;
      s.errors.topics = null;
    }));
    try {
      const list = await api.listTopics();
      set(produce((s: ForestDataState) => {
        s.topics = Object.fromEntries(list.map((t) => [t.id, t]));
        s.loading.topics = false;
      }));
    } catch (e) {
      set(produce((s: ForestDataState) => {
        s.loading.topics = false;
        s.errors.topics = errorMessage(e);
      }));
      throw e;
    }
  },

  fetchTopic: async (id) => {
    set(produce((s: ForestDataState) => {
      s.loading.topicDetail[id] = true;
      s.errors.topicDetail[id] = null;
    }));
    try {
      const detail = await api.getTopic(id);
      set(produce((s: ForestDataState) => {
        s.topicDetails[id] = detail;
        s.topics[id] = {
          id: detail.id,
          title: detail.title,
          node_count: detail.nodes.length,
          updated_at: detail.updated_at,
        };
        s.loading.topicDetail[id] = false;
      }));
      return detail;
    } catch (e) {
      set(produce((s: ForestDataState) => {
        s.loading.topicDetail[id] = false;
        s.errors.topicDetail[id] = errorMessage(e);
      }));
      throw e;
    }
  },

  fetchNode: async (id) => {
    set(produce((s: ForestDataState) => {
      s.loading.node[id] = true;
      s.errors.node[id] = null;
    }));
    try {
      const node = await api.getNode(id);
      set(produce((s: ForestDataState) => {
        s.nodes[id] = node;
        s.loading.node[id] = false;
      }));
      return node;
    } catch (e) {
      set(produce((s: ForestDataState) => {
        s.loading.node[id] = false;
        s.errors.node[id] = errorMessage(e);
      }));
      throw e;
    }
  },

  createTopic: async (title) => {
    const topic = await api.createTopic({ title });
    // Re-fetch the detail so the root node lands in `nodes`.
    await get().fetchTopic(topic.id);
    return topic;
  },

  createNode: async (input) => {
    const node = await api.createNode(input);
    set(produce((s: ForestDataState) => {
      s.nodes[node.id] = node;
      // Refresh the topic summary's count if we have it cached.
      const detail = s.topicDetails[node.topic];
      if (detail) {
        detail.nodes.push({
          id: node.id,
          parent: node.parent,
          type: node.type,
          title: node.title,
          links: node.links,
          updated_at: node.updated_at,
        });
      }
      const summary = s.topics[node.topic];
      if (summary) summary.node_count += 1;
    }));
    return node;
  },

  patchNode: async (id, patch) => {
    // Optimistic local patch. If `patch` only touches `content` / `title`
    // / `links`, this is safe; the server merge will overwrite anyway.
    const prev = get().nodes[id];
    if (prev) {
      set(produce((s: ForestDataState) => {
        const n = s.nodes[id];
        if (!n) return;
        if (patch.title !== undefined) n.title = patch.title;
        if (patch.content !== undefined) n.content = patch.content;
        if (patch.links !== undefined) n.links = patch.links;
        if (patch.type !== undefined) n.type = patch.type;
      }));
    }
    try {
      const updated = await api.updateNode(id, patch);
      set(produce((s: ForestDataState) => {
        s.nodes[id] = updated;
        // Sync the topic detail summary too, so a topic listing reflects
        // the new title without a separate fetch.
        const detail = s.topicDetails[updated.topic];
        if (detail) {
          const summary = detail.nodes.find((n) => n.id === id);
          if (summary) {
            summary.title = updated.title;
            summary.links = updated.links;
            summary.type = updated.type;
            summary.updated_at = updated.updated_at;
          }
        }
      }));
      return updated;
    } catch (e) {
      // Roll back the optimistic patch.
      if (prev) {
        set(produce((s: ForestDataState) => {
          s.nodes[id] = prev;
        }));
      }
      throw e;
    }
  },

  deleteNode: async (id) => {
    const prev = get().nodes[id];
    set(produce((s: ForestDataState) => {
      delete s.nodes[id];
      if (prev) {
        const detail = s.topicDetails[prev.topic];
        if (detail) detail.nodes = detail.nodes.filter((n) => n.id !== id);
        const summary = s.topics[prev.topic];
        if (summary) summary.node_count = Math.max(0, summary.node_count - 1);
      }
    }));
    try {
      await api.deleteNode(id);
    } catch (e) {
      // Restore on failure.
      if (prev) {
        set(produce((s: ForestDataState) => {
          s.nodes[id] = prev;
          const detail = s.topicDetails[prev.topic];
          if (detail && !detail.nodes.some((n) => n.id === id)) {
            detail.nodes.push({
              id: prev.id,
              parent: prev.parent,
              type: prev.type,
              title: prev.title,
              links: prev.links,
              updated_at: prev.updated_at,
            });
          }
        }));
      }
      throw e;
    }
  },
}));

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
