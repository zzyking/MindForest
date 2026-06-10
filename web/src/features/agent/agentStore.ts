/**
 * Zustand store driving the agent prompt bar + draft overlay.
 *
 * One pending session at a time. While `streaming` is true the bar
 * stays disabled and a Cancel button replaces Send. The overlay reads
 * `tokens` (concatenated draft text) and `proposals` (parsed structured
 * edits) and the user-applied flags per proposal.
 *
 * Multi-turn: the store tracks `history` — every prior turn in the
 * current session. The first user prompt opens the session; follow-ups
 * append to history (the previous user prompt + the streamed assistant
 * draft) and ship that history with the next request. The model gets to
 * see what it said last time and what the user said next.
 *
 * Sessions are per-topic and survive hiding the panel: `close()` only
 * flips visibility (Esc / ✕ / collapsing the agent surface), and the
 * conversation continues on the next prompt. It actually ends on the
 * panel's explicit Clear (`reset`) or when a prompt is issued from a
 * different topic (`sessionTopicId` mismatch starts a fresh session —
 * history from topic A must never ship with a request about topic B).
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

export interface ProposalEntry {
  id: string;
  proposal: AgentProposal;
  status: ProposalStatus;
  /** Which turn in the conversation produced this proposal. Lets the
   *  overlay group proposals by turn for clarity in long sessions. */
  turnIndex: number;
  error?: string;
}

interface AgentSessionState {
  /** Panel visibility — NOT session lifetime. See header comment. */
  open: boolean;
  streaming: boolean;
  /** Topic this session belongs to. Proposals are applied against it
   *  (not the current route, which the user may have navigated away
   *  from), and a prompt from a different topic starts a new session. */
  sessionTopicId: TopicId | null;
  /** Most recent user prompt the bar issued. */
  prompt: string;
  /** Live tokens for the *current* (in-flight) assistant turn only. */
  draft: string;
  /** All proposals across the session, oldest first. */
  proposals: ProposalEntry[];
  errors: string[];
  abort: AbortController | null;
  /** Confirmed conversation history — closed turns. The latest user
   *  prompt + streamed draft become a pair of entries here when a turn
   *  finishes successfully. */
  history: AgentTurn[];
  /** 1-based index of the in-flight turn (for grouping proposals). */
  turnCount: number;
  /** Accumulated client_id → real NodeId mappings across all accepted
   *  proposals in this session. Used to resolve cross-proposal references
   *  when the user accepts cards individually rather than via Accept all. */
  resolvedTable: ResolveTable;

  startStream: (input: {
    topicId: TopicId;
    focusedNodeId: NodeId | null;
    prompt: string;
  }) => Promise<void>;
  cancel: () => void;
  /** Hide the panel. The session (history, proposals) survives. */
  close: () => void;
  /** Re-show a hidden panel if there's a session worth showing. */
  show: () => void;
  setProposalStatus: (id: string, status: ProposalStatus, error?: string) => void;
  mergeResolvedTable: (updates: ResolveTable) => void;
  reset: () => void;
}

const initial = {
  open: false,
  streaming: false,
  sessionTopicId: null as TopicId | null,
  prompt: "",
  draft: "",
  proposals: [] as ProposalEntry[],
  errors: [] as string[],
  abort: null as AbortController | null,
  history: [] as AgentTurn[],
  turnCount: 0,
  resolvedTable: {} as ResolveTable,
};

let proposalCounter = 0;
function nextProposalId(): string {
  proposalCounter += 1;
  return `p-${proposalCounter}`;
}

export const useAgentSession = create<AgentSessionState>((set, get) => ({
  ...initial,

  startStream: async ({ topicId, focusedNodeId, prompt }) => {
    // If a previous stream is still in flight, drop it before starting
    // a new one — only one in-flight stream at a time per session.
    get().abort?.abort();
    const controller = new AbortController();
    // A prompt from a different topic starts a fresh session — topic A's
    // history must not ship with (or render next to) topic B's request.
    const sameTopic = get().sessionTopicId === topicId;
    // Snapshot history at request time. The user's *new* prompt is
    // attached separately on the request body; we don't double-include
    // it in `history`.
    const historyForRequest = sameTopic ? get().history : [];
    const turnIndex = sameTopic ? get().turnCount + 1 : 1;
    set((s) => ({
      open: true,
      streaming: true,
      sessionTopicId: topicId,
      prompt,
      draft: "",
      // Keep prior proposals so the user can still accept/reject them
      // after asking a follow-up. Fresh ones land alongside.
      proposals: sameTopic ? s.proposals : [],
      errors: [],
      abort: controller,
      turnCount: turnIndex,
      history: sameTopic ? s.history : [],
      resolvedTable: sameTopic ? s.resolvedTable : {},
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
      set((s) => ({
        ...s,
        streaming: false,
        errors: [...s.errors, errorMessage(e)],
        abort: null,
      }));
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
            set((s) => ({ draft: s.draft + ev.text }));
            break;
          case "proposal":
            set((s) => ({
              proposals: [
                ...s.proposals,
                {
                  id: nextProposalId(),
                  proposal: ev.proposal,
                  status: "pending",
                  turnIndex,
                },
              ],
            }));
            break;
          case "error":
            set((s) => ({ errors: [...s.errors, ev.message] }));
            break;
          case "done":
            sawDone = true;
            break;
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        set((s) => ({ errors: [...s.errors, errorMessage(e)] }));
      }
    } finally {
      // Only commit the turn to history when we got at least the
      // server's `done` and the request wasn't aborted. A canceled or
      // crashed stream shouldn't be replayed verbatim next turn.
      if (sawDone && !controller.signal.aborted && assistantText.length > 0) {
        set((s) => ({
          history: [
            ...s.history,
            { role: "user", text: prompt },
            { role: "assistant", text: assistantText },
          ],
          // The turn now lives in history — clear the in-flight fields
          // so the overlay doesn't render the same turn twice (once as
          // a committed TurnPair, once as the "active turn" block).
          draft: "",
          prompt: "",
        }));
      }
      set({ streaming: false, abort: null });
    }
  },

  cancel: () => {
    get().abort?.abort();
    set({ streaming: false, abort: null });
  },

  // Hiding deliberately does NOT abort: a stream started before the
  // panel was hidden keeps running and commits its turn silently — the
  // bar's Cancel button (driven by `streaming`) remains the abort path.
  close: () => set({ open: false }),

  show: () =>
    set((s) =>
      s.streaming ||
      s.history.length > 0 ||
      s.proposals.length > 0 ||
      s.errors.length > 0
        ? { open: true }
        : s,
    ),

  setProposalStatus: (id, status, error) =>
    set((s) => ({
      proposals: s.proposals.map((p) =>
        p.id === id ? { ...p, status, error } : p,
      ),
    })),

  mergeResolvedTable: (updates) =>
    set((s) => ({ resolvedTable: { ...s.resolvedTable, ...updates } })),

  reset: () => {
    get().abort?.abort();
    set({ ...initial });
  },
}));

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
