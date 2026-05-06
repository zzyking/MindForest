/**
 * Tiny zustand store driving the agent prompt bar + draft overlay.
 *
 * One pending session at a time. While `streaming` is true the bar
 * stays disabled and a Cancel button replaces Send. The overlay reads
 * `tokens` (concatenated draft text) and `proposals` (parsed structured
 * edits) and the user-applied flags per proposal.
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
  NodeId,
  TopicId,
} from "@/lib/types";

export type ProposalStatus = "pending" | "accepted" | "rejected" | "failed";

export interface ProposalEntry {
  id: string;
  proposal: AgentProposal;
  status: ProposalStatus;
  error?: string;
}

interface AgentSessionState {
  open: boolean;
  streaming: boolean;
  prompt: string;
  draft: string;
  proposals: ProposalEntry[];
  errors: string[];
  abort: AbortController | null;

  startStream: (input: {
    topicId: TopicId;
    focusedNodeId: NodeId | null;
    prompt: string;
  }) => Promise<void>;
  cancel: () => void;
  close: () => void;
  setProposalStatus: (id: string, status: ProposalStatus, error?: string) => void;
  reset: () => void;
}

const initial = {
  open: false,
  streaming: false,
  prompt: "",
  draft: "",
  proposals: [] as ProposalEntry[],
  errors: [] as string[],
  abort: null as AbortController | null,
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
    // a new one — only one session at a time.
    get().abort?.abort();
    const controller = new AbortController();
    set({
      open: true,
      streaming: true,
      prompt,
      draft: "",
      proposals: [],
      errors: [],
      abort: controller,
    });

    let stream;
    try {
      stream = streamAgentPropose(
        {
          topic_id: topicId,
          focused_node_id: focusedNodeId,
          prompt,
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

    try {
      for await (const ev of stream.events as AsyncIterable<AgentEvent>) {
        if (controller.signal.aborted) break;
        switch (ev.kind) {
          case "token":
            set((s) => ({ draft: s.draft + ev.text }));
            break;
          case "proposal":
            set((s) => ({
              proposals: [
                ...s.proposals,
                { id: nextProposalId(), proposal: ev.proposal, status: "pending" },
              ],
            }));
            break;
          case "error":
            set((s) => ({ errors: [...s.errors, ev.message] }));
            break;
          case "done":
            // Stream end — the loop exits naturally on the next read.
            break;
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        set((s) => ({ errors: [...s.errors, errorMessage(e)] }));
      }
    } finally {
      set({ streaming: false, abort: null });
    }
  },

  cancel: () => {
    get().abort?.abort();
    set({ streaming: false, abort: null });
  },

  close: () => {
    get().abort?.abort();
    set({ ...initial });
  },

  setProposalStatus: (id, status, error) =>
    set((s) => ({
      proposals: s.proposals.map((p) =>
        p.id === id ? { ...p, status, error } : p,
      ),
    })),

  reset: () => set({ ...initial }),
}));

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
