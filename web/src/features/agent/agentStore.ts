/**
 * Zustand store driving the agent prompt bar + draft overlay.
 *
 * One in-flight stream at a time, but MANY conversations: one per
 * topic plus a single global one, kept in `conversations` keyed by
 * `ConversationKey` (a TopicId, or GLOBAL_KEY). Which conversation the
 * bar talks to is `scope` + the current route's topic — see
 * `useConversationKey` in conversationKey.ts.
 *
 * - Topic conversations are isolated by construction: each request
 *   ships only its own key's history, so topic A's exchange can never
 *   leak into a request about topic B.
 * - The global conversation deliberately spans topics: history rides
 *   along as the user navigates, while each request still anchors on
 *   the topic currently open (the server hydrates context from
 *   `topic_id` — there is no topic-less request).
 *
 * Multi-turn: each conversation tracks `history` — every prior closed
 * turn. Follow-ups ship that history with the next request, so the
 * model sees what it said last time and what the user said next.
 *
 * Conversations survive hiding the panel: `close()` only flips
 * visibility (Esc / ✕ / collapsing the agent surface). A conversation
 * actually ends on the panel's explicit Clear (`clear(key)`).
 *
 * Proposals remember the topic they were generated against
 * (`ProposalEntry.topicId`), so accepting applies to that topic even
 * if the user has navigated elsewhere — essential for the global
 * conversation, where proposals from different topics coexist.
 *
 * Aborting mid-stream just closes the underlying fetch — the server
 * tears down its task on the next chunk because the SSE response is
 * single-consumer and the channel drops.
 */

import { create } from "zustand";

import { streamAgentPropose } from "@/lib/api";
import type {
  AgentEvent,
  AgentProposal,
  AgentTurn,
  NodeId,
  TopicId,
} from "@/lib/types";
import type { ResolveTable } from "./applyProposal";

export type ProposalStatus = "pending" | "accepted" | "rejected" | "failed";

export type AgentScope = "topic" | "global";

/** Key of the workspace-wide conversation in `conversations`. The
 *  sentinel can't collide with a TopicId (slugs never start with
 *  underscores). */
export const GLOBAL_KEY = "__global__";
export type ConversationKey = TopicId | typeof GLOBAL_KEY;

export interface ProposalEntry {
  id: string;
  proposal: AgentProposal;
  status: ProposalStatus;
  /** Which turn in the conversation produced this proposal. Lets the
   *  overlay group proposals by turn for clarity in long sessions. */
  turnIndex: number;
  /** Topic the proposal was generated against (the request's anchor).
   *  Accepts apply here, not to wherever the user navigated since. */
  topicId: TopicId;
  error?: string;
}

export interface Conversation {
  /** In-flight (uncommitted) user prompt. Cleared when the turn lands
   *  in history — doubles as the "an uncommitted turn exists" flag. */
  prompt: string;
  /** Live tokens for the in-flight assistant turn only. */
  draft: string;
  /** Confirmed conversation history — closed turns, oldest first. */
  history: AgentTurn[];
  /** 1-based index of the latest turn (for grouping proposals). */
  turnCount: number;
  /** All proposals across the conversation, oldest first. */
  proposals: ProposalEntry[];
  errors: string[];
  /** Accumulated client_id → real NodeId mappings across accepted
   *  proposals. Resolves cross-proposal references when the user
   *  accepts cards individually rather than via Accept all. */
  resolvedTable: ResolveTable;
}

const emptyConversation = (): Conversation => ({
  prompt: "",
  draft: "",
  history: [],
  turnCount: 0,
  proposals: [],
  errors: [],
  resolvedTable: {},
});

interface AgentSessionState {
  /** Panel visibility — NOT conversation lifetime. */
  open: boolean;
  streaming: boolean;
  /** Conversation the in-flight stream writes into. Captured at
   *  startStream so switching scope/topic mid-stream can't cross-wire
   *  tokens into the wrong conversation. */
  streamingKey: ConversationKey | null;
  /** Which conversation the bar talks to: the open topic's, or the
   *  global one. */
  scope: AgentScope;
  conversations: Partial<Record<ConversationKey, Conversation>>;
  abort: AbortController | null;

  setScope: (scope: AgentScope) => void;
  startStream: (input: {
    topicId: TopicId;
    focusedNodeId: NodeId | null;
    prompt: string;
  }) => Promise<void>;
  cancel: () => void;
  /** Hide the panel. Conversations survive. */
  close: () => void;
  /** Re-show a hidden panel if the given conversation has content. */
  show: (key: ConversationKey | null) => void;
  /** Explicitly end one conversation (aborts its in-flight stream). */
  clear: (key: ConversationKey) => void;
  setProposalStatus: (
    key: ConversationKey,
    id: string,
    status: ProposalStatus,
    error?: string,
  ) => void;
  mergeResolvedTable: (key: ConversationKey, updates: ResolveTable) => void;
}

let proposalCounter = 0;
function nextProposalId(): string {
  proposalCounter += 1;
  return `p-${proposalCounter}`;
}

export const useAgentSession = create<AgentSessionState>((set, get) => {
  /** Apply `fn` to one conversation, creating it on first touch. */
  const patch = (key: ConversationKey, fn: (c: Conversation) => Partial<Conversation>) =>
    set((s) => {
      const conv = s.conversations[key] ?? emptyConversation();
      return { conversations: { ...s.conversations, [key]: { ...conv, ...fn(conv) } } };
    });

  return {
    open: false,
    streaming: false,
    streamingKey: null,
    scope: "topic",
    conversations: {},
    abort: null,

    setScope: (scope) => set({ scope }),

    startStream: async ({ topicId, focusedNodeId, prompt }) => {
      // If a previous stream is still in flight, drop it before
      // starting a new one — one in-flight stream at a time.
      get().abort?.abort();
      const controller = new AbortController();
      const key: ConversationKey = get().scope === "global" ? GLOBAL_KEY : topicId;
      const conv = get().conversations[key] ?? emptyConversation();
      // Snapshot history at request time. The user's *new* prompt is
      // attached separately on the request body; we don't
      // double-include it in `history`.
      const historyForRequest = conv.history;
      const turnIndex = conv.turnCount + 1;
      set({ open: true, streaming: true, streamingKey: key, abort: controller });
      patch(key, () => ({
        prompt,
        draft: "",
        errors: [],
        turnCount: turnIndex,
        // Prior proposals stay so the user can still accept/reject
        // them after asking a follow-up. Fresh ones land alongside.
      }));

      let stream;
      try {
        stream = streamAgentPropose(
          {
            topic_id: topicId,
            focused_node_id: focusedNodeId,
            prompt,
            history: historyForRequest,
          },
          controller.signal,
        );
      } catch (e) {
        patch(key, (c) => ({ errors: [...c.errors, errorMessage(e)] }));
        set({ streaming: false, streamingKey: null, abort: null });
        return;
      }

      let assistantText = "";
      let sawDone = false;
      try {
        for await (const ev of stream.events as AsyncIterable<AgentEvent>) {
          if (controller.signal.aborted) break;
          switch (ev.kind) {
            case "token":
              assistantText += ev.text;
              patch(key, (c) => ({ draft: c.draft + ev.text }));
              break;
            case "proposal":
              patch(key, (c) => ({
                proposals: [
                  ...c.proposals,
                  {
                    id: nextProposalId(),
                    proposal: ev.proposal,
                    status: "pending",
                    turnIndex,
                    topicId,
                  },
                ],
              }));
              break;
            case "error":
              patch(key, (c) => ({ errors: [...c.errors, ev.message] }));
              break;
            case "done":
              sawDone = true;
              break;
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          patch(key, (c) => ({ errors: [...c.errors, errorMessage(e)] }));
        }
      } finally {
        // Only commit the turn to history when we got at least the
        // server's `done` and the request wasn't aborted. A canceled
        // or crashed stream shouldn't be replayed verbatim next turn.
        if (sawDone && !controller.signal.aborted && assistantText.length > 0) {
          patch(key, (c) => ({
            history: [
              ...c.history,
              { role: "user", text: prompt },
              { role: "assistant", text: assistantText },
            ],
            // The turn now lives in history — clear the in-flight
            // fields so the overlay doesn't render it twice.
            draft: "",
            prompt: "",
          }));
        }
        set({ streaming: false, streamingKey: null, abort: null });
      }
    },

    cancel: () => {
      get().abort?.abort();
      set({ streaming: false, streamingKey: null, abort: null });
    },

    // Hiding deliberately does NOT abort: a stream started before the
    // panel was hidden keeps running and commits its turn silently —
    // the bar's Cancel button (driven by `streaming`) remains the
    // abort path.
    close: () => set({ open: false }),

    show: (key) =>
      set((s) => {
        if (!key) return s;
        const c = s.conversations[key];
        const hasContent =
          !!c &&
          (c.history.length > 0 ||
            c.proposals.length > 0 ||
            c.errors.length > 0 ||
            c.prompt !== "" ||
            (s.streaming && s.streamingKey === key));
        return hasContent ? { open: true } : s;
      }),

    clear: (key) => {
      if (get().streamingKey === key) get().cancel();
      set((s) => {
        const { [key]: _gone, ...rest } = s.conversations;
        return { conversations: rest, open: false };
      });
    },

    setProposalStatus: (key, id, status, error) =>
      patch(key, (c) => ({
        proposals: c.proposals.map((p) => (p.id === id ? { ...p, status, error } : p)),
      })),

    mergeResolvedTable: (key, updates) =>
      patch(key, (c) => ({ resolvedTable: { ...c.resolvedTable, ...updates } })),
  };
});

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
