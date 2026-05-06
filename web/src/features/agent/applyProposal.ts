/**
 * Apply one accepted `AgentProposal` to the vault via the existing
 * forestData store actions.
 *
 * The agent emits proposals with two reference shapes — existing ULID
 * NodeIds, or `client_id` placeholders that point at a yet-to-be-applied
 * AddNode in the same batch. We resolve placeholders against an
 * accumulator the caller threads through accept calls.
 */

import { useForestData } from "@/stores/forestData";
import type { AgentProposal, NodeId, NodeRef, TopicId } from "@/lib/types";

export type ResolveTable = Record<string, NodeId>;

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function isExistingId(ref: NodeRef): ref is NodeId {
  return ULID_RE.test(ref);
}

function resolveRef(ref: NodeRef, table: ResolveTable): NodeId {
  if (isExistingId(ref)) return ref;
  const resolved = table[ref];
  if (!resolved) {
    throw new Error(`unresolved client_id: ${ref}`);
  }
  return resolved;
}

/**
 * Apply a single proposal. Returns updates to the resolution table
 * (i.e. for AddNode with a client_id, the new real id).
 */
export async function applyProposal(
  proposal: AgentProposal,
  topicId: TopicId,
  table: ResolveTable,
): Promise<ResolveTable> {
  const store = useForestData.getState();
  switch (proposal.op) {
    case "add_node": {
      const parent = resolveRef(proposal.parent, table);
      const node = await store.createNode({
        topic: topicId,
        parent,
        title: proposal.title,
        content: proposal.content ?? "",
        node_type: proposal.type,
      });
      if (proposal.client_id) {
        return { [proposal.client_id]: node.id };
      }
      return {};
    }
    case "update_node": {
      await store.patchNode(proposal.id, {
        title: proposal.title,
        content: proposal.content,
        type: proposal.type,
      });
      return {};
    }
    case "delete_node": {
      await store.deleteNode(proposal.id);
      return {};
    }
    case "link": {
      const from = resolveRef(proposal.from, table);
      const to = resolveRef(proposal.to, table);
      const fromNode = useForestData.getState().nodes[from];
      if (!fromNode) {
        throw new Error(`link source node not loaded: ${from}`);
      }
      if (fromNode.links.includes(to)) return {};
      await store.patchNode(from, { links: [...fromNode.links, to] });
      return {};
    }
    case "unlink": {
      const fromNode = useForestData.getState().nodes[proposal.from];
      if (!fromNode) {
        throw new Error(`unlink source node not loaded: ${proposal.from}`);
      }
      const next = fromNode.links.filter((l) => l !== proposal.to);
      if (next.length === fromNode.links.length) return {};
      await store.patchNode(proposal.from, { links: next });
      return {};
    }
  }
}
