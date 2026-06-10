/**
 * Which conversation is the agent surface talking to right now?
 * Shared by AgentPromptBar (submit target) and DraftOverlay (display)
 * so the two can never disagree.
 *
 * scope "topic"  → the open topic's conversation; `key` is null on the
 *                  index route, where there's no topic to anchor a
 *                  request on.
 * scope "global" → the single workspace-wide conversation. Requests
 *                  still anchor on the open topic (the server hydrates
 *                  context from `topic_id`), but the history spans
 *                  topics as the user navigates.
 */

import { useParams, useRouterState } from "@tanstack/react-router";

import type { NodeId, TopicId } from "@/lib/types";
import { GLOBAL_KEY, useAgentSession, type ConversationKey } from "./agentStore";

export function useConversationKey(): {
  key: ConversationKey | null;
  topicId: TopicId | null;
  focusedNodeId: NodeId | null;
} {
  const { topicId, focusedNodeId } = useCurrentRouteContext();
  const scope = useAgentSession((s) => s.scope);
  return {
    key: scope === "global" ? GLOBAL_KEY : topicId,
    topicId,
    focusedNodeId,
  };
}

/**
 * Pull `topicId` / `nodeId` out of the active route match, regardless
 * of which deep route is currently mounted. The match params shape is
 * `{ topicId?: string, nodeId?: string }` — both are optional because
 * the index route has neither.
 */
export function useCurrentRouteContext(): {
  topicId: TopicId | null;
  focusedNodeId: NodeId | null;
} {
  const matches = useRouterState({ select: (s) => s.matches });
  // Fallback params — must be read *before* the early return below so
  // both hooks run unconditionally on every render. Returning early
  // past a hook call changes the hook order between "/" and
  // "/$topicId/…" renders, which React punishes by remounting the
  // tree from scratch via the nearest error boundary (wiping sidebar
  // expansion state and flashing the whole shell).
  const fallback = useParamsCompat();
  // Prefer the deepest match's params — that's the one with topicId / nodeId.
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i];
    if (!match) continue;
    const params = match.params as { topicId?: string; nodeId?: string };
    if (params?.topicId) {
      return { topicId: params.topicId, focusedNodeId: params.nodeId ?? null };
    }
  }
  return {
    topicId: fallback.topicId ?? null,
    focusedNodeId: fallback.nodeId ?? null,
  };
}

// Wrapping useParams so the typing matches both index + nested routes.
function useParamsCompat() {
  return useParams({ strict: false }) as {
    topicId?: string;
    nodeId?: string;
  };
}
