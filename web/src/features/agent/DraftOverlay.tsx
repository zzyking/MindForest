/**
 * Side-panel overlay that surfaces the live agent reply: streaming
 * prose at the top, a list of structured proposals below with
 * accept / reject affordances. Closes when the user dismisses
 * explicitly — we don't auto-close on Done so the user has time to
 * decide on each proposal.
 *
 * Accept order matters when proposals reference each other through
 * `client_id` placeholders, so the overlay accepts in array order and
 * threads the resolution table forward.
 */

import { useState } from "react";
import { useParams } from "@tanstack/react-router";

import { cn } from "@/lib/cn";
import type { AgentProposal } from "@/lib/types";
import { useAgentSession, type ProposalEntry } from "./agentStore";
import { applyProposal, type ResolveTable } from "./applyProposal";

export function DraftOverlay() {
  const open = useAgentSession((s) => s.open);
  const streaming = useAgentSession((s) => s.streaming);
  const draft = useAgentSession((s) => s.draft);
  const proposals = useAgentSession((s) => s.proposals);
  const errors = useAgentSession((s) => s.errors);
  const prompt = useAgentSession((s) => s.prompt);
  const history = useAgentSession((s) => s.history);
  const turnCount = useAgentSession((s) => s.turnCount);
  const close = useAgentSession((s) => s.close);
  const setProposalStatus = useAgentSession((s) => s.setProposalStatus);
  const params = useParams({ strict: false }) as { topicId?: string };
  const [bulkBusy, setBulkBusy] = useState(false);

  if (!open) return null;

  const acceptOne = async (entry: ProposalEntry, table: ResolveTable): Promise<ResolveTable> => {
    if (entry.status !== "pending" || !params.topicId) return table;
    try {
      const next = await applyProposal(entry.proposal, params.topicId, table);
      setProposalStatus(entry.id, "accepted");
      return { ...table, ...next };
    } catch (e) {
      setProposalStatus(entry.id, "failed", errorMessage(e));
      return table;
    }
  };

  const acceptAll = async () => {
    if (!params.topicId) return;
    setBulkBusy(true);
    let table: ResolveTable = {};
    for (const entry of proposals) {
      table = await acceptOne(entry, table);
    }
    setBulkBusy(false);
  };

  const rejectAll = () => {
    proposals.forEach((p) => {
      if (p.status === "pending") setProposalStatus(p.id, "rejected");
    });
  };

  return (
    <aside
      role="dialog"
      aria-label="Agent draft"
      className={cn(
        "absolute right-4 top-4 bottom-24 w-[min(440px,calc(100vw-2rem))]",
        "shadow-glass border-forest-200 bg-sand-50/95 z-40 flex flex-col rounded-2xl border backdrop-blur-md",
      )}
    >
      <header className="border-forest-100 flex items-center justify-between border-b px-4 py-3">
        <div>
          <div className="text-forest-500 text-[10px] uppercase tracking-wider">Agent draft</div>
          <div className="text-forest-900 line-clamp-1 text-sm">{prompt || "—"}</div>
        </div>
        <button
          type="button"
          onClick={close}
          className="text-forest-500 hover:text-forest-800 rounded-full px-2 py-0.5 text-xs"
          aria-label="Close draft"
        >
          ✕
        </button>
      </header>

      <section className="flex-1 overflow-y-auto px-4 py-3">
        {/* Confirmed prior turns. Each (user, assistant) pair becomes
            two stacked bubbles so the user can scroll the conversation. */}
        {history.length > 0 && (
          <div className="mb-4 flex flex-col gap-3">
            {pairTurns(history).map((pair, idx) => (
              <TurnPair
                key={idx}
                turnIndex={idx + 1}
                userText={pair.user}
                assistantText={pair.assistant}
                proposals={proposals.filter((p) => p.turnIndex === idx + 1)}
                onAccept={acceptOne}
                onReject={(id) => setProposalStatus(id, "rejected")}
              />
            ))}
          </div>
        )}
        {/* Active (in-flight or just-finished) turn. */}
        {(streaming || draft || proposals.some((p) => p.turnIndex === turnCount)) && (
          <div className="border-forest-100 flex flex-col gap-2 border-t pt-3">
            {history.length > 0 && (
              <div className="text-forest-400 text-[10px] uppercase tracking-wider">
                Turn {turnCount}
              </div>
            )}
            {prompt && (
              <div className="text-forest-700 text-xs">
                <span className="text-forest-500 mr-1 font-medium">You:</span>
                {prompt}
              </div>
            )}
            <DraftText text={draft} streaming={streaming} />
            {proposals.filter((p) => p.turnIndex === turnCount).length > 0 && (
              <ProposalList
                proposals={proposals.filter((p) => p.turnIndex === turnCount)}
                onAccept={acceptOne}
                onReject={(id) => setProposalStatus(id, "rejected")}
              />
            )}
          </div>
        )}
        {errors.length > 0 && (
          <div className="mt-3 rounded-md border border-rust-300 bg-rust-50 px-3 py-2 text-xs text-rust-800">
            {errors.map((m, i) => (
              <div key={i}>{m}</div>
            ))}
          </div>
        )}
      </section>

      <footer className="border-forest-100 flex items-center justify-end gap-2 border-t px-4 py-2">
        <button
          type="button"
          onClick={rejectAll}
          disabled={bulkBusy || proposals.every((p) => p.status !== "pending")}
          className="text-forest-700 hover:bg-forest-100 disabled:opacity-40 rounded-full px-3 py-1 text-xs"
        >
          Reject all
        </button>
        <button
          type="button"
          onClick={acceptAll}
          disabled={bulkBusy || streaming || proposals.every((p) => p.status !== "pending") || !params.topicId}
          className="text-sand-100 bg-forest-700 hover:bg-forest-800 disabled:opacity-40 rounded-full px-3 py-1 text-xs"
        >
          {bulkBusy ? "Applying…" : "Accept all"}
        </button>
      </footer>
    </aside>
  );
}

/**
 * Pair user/assistant turns by walking the flat history array. Always
 * emits user→assistant pairs; an unpaired trailing turn (shouldn't
 * happen but defensive) is dropped.
 */
function pairTurns(
  history: { role: "user" | "assistant"; text: string }[],
): { user: string; assistant: string }[] {
  const out: { user: string; assistant: string }[] = [];
  for (let i = 0; i < history.length - 1; i += 2) {
    const u = history[i];
    const a = history[i + 1];
    if (u?.role === "user" && a?.role === "assistant") {
      out.push({ user: u.text, assistant: a.text });
    }
  }
  return out;
}

function TurnPair({
  turnIndex,
  userText,
  assistantText,
  proposals,
  onAccept,
  onReject,
}: {
  turnIndex: number;
  userText: string;
  assistantText: string;
  proposals: ProposalEntry[];
  onAccept: (entry: ProposalEntry, table: ResolveTable) => Promise<ResolveTable>;
  onReject: (id: string) => void;
}) {
  const visible = stripTrailingProposalsBlock(assistantText);
  return (
    <div className="flex flex-col gap-2">
      <div className="text-forest-400 text-[10px] uppercase tracking-wider">
        Turn {turnIndex}
      </div>
      <div className="text-forest-700 text-xs">
        <span className="text-forest-500 mr-1 font-medium">You:</span>
        {userText}
      </div>
      <div className="text-forest-800 whitespace-pre-wrap text-sm leading-relaxed">
        {visible || "(no reply text)"}
      </div>
      {proposals.length > 0 && (
        <ProposalList proposals={proposals} onAccept={onAccept} onReject={onReject} />
      )}
    </div>
  );
}

function DraftText({ text, streaming }: { text: string; streaming: boolean }) {
  // Strip the trailing fenced proposals block from the prose view —
  // the structured list below renders it more usefully than raw JSON.
  const visible = stripTrailingProposalsBlock(text);
  return (
    <div className="text-forest-800 whitespace-pre-wrap text-sm leading-relaxed">
      {visible || (streaming ? "Thinking…" : "(no reply)")}
      {streaming && <span className="inline-block animate-pulse">▍</span>}
    </div>
  );
}

function ProposalList({
  proposals,
  onAccept,
  onReject,
}: {
  proposals: ProposalEntry[];
  onAccept: (entry: ProposalEntry, table: ResolveTable) => Promise<ResolveTable>;
  onReject: (id: string) => void;
}) {
  return (
    <ul className="mt-4 space-y-2">
      {proposals.map((entry) => (
        <ProposalCard
          key={entry.id}
          entry={entry}
          onAccept={() => onAccept(entry, {})}
          onReject={() => onReject(entry.id)}
        />
      ))}
    </ul>
  );
}

function ProposalCard({
  entry,
  onAccept,
  onReject,
}: {
  entry: ProposalEntry;
  onAccept: () => Promise<ResolveTable>;
  onReject: () => void;
}) {
  const summary = describeProposal(entry.proposal);
  return (
    <li
      className={cn(
        "border-forest-100 bg-sand-100/70 rounded-lg border px-3 py-2 text-xs",
        entry.status === "accepted" && "border-forest-300 bg-forest-50",
        entry.status === "rejected" && "opacity-50",
        entry.status === "failed" && "border-rust-300 bg-rust-50",
      )}
    >
      <div className="text-forest-500 mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider">
        <span>{summary.op}</span>
        <StatusBadge status={entry.status} />
      </div>
      <div className="text-forest-900">{summary.title}</div>
      {summary.detail && (
        <div className="text-forest-600 mt-1 line-clamp-3 whitespace-pre-wrap">{summary.detail}</div>
      )}
      {entry.error && <div className="mt-1 text-rust-700">{entry.error}</div>}
      {entry.status === "pending" && (
        <div className="mt-2 flex justify-end gap-1">
          <button
            type="button"
            onClick={onReject}
            className="text-forest-700 hover:bg-forest-100 rounded-full px-2 py-0.5"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={() => void onAccept()}
            className="text-sand-100 bg-forest-700 hover:bg-forest-800 rounded-full px-2 py-0.5"
          >
            Accept
          </button>
        </div>
      )}
    </li>
  );
}

function StatusBadge({ status }: { status: ProposalEntry["status"] }) {
  if (status === "pending") return null;
  const map: Record<"accepted" | "rejected" | "failed", string> = {
    accepted: "✓ accepted",
    rejected: "rejected",
    failed: "failed",
  };
  return <span className="lowercase">{map[status]}</span>;
}

function describeProposal(p: AgentProposal): { op: string; title: string; detail?: string } {
  switch (p.op) {
    case "add_node":
      return {
        op: "add",
        title: p.title,
        detail: p.content || `under ${p.parent}`,
      };
    case "update_node":
      return {
        op: "update",
        title: p.title ?? `node ${p.id.slice(0, 8)}…`,
        detail: p.content,
      };
    case "delete_node":
      return { op: "delete", title: `node ${p.id.slice(0, 8)}…` };
    case "link":
      return { op: "link", title: `${shortRef(p.from)} → ${shortRef(p.to)}` };
    case "unlink":
      return { op: "unlink", title: `${shortRef(p.from)} ⇸ ${shortRef(p.to)}` };
  }
}

function shortRef(r: string): string {
  return r.length > 10 ? `${r.slice(0, 8)}…` : r;
}

const FENCE = "```mindforest-proposals";

function stripTrailingProposalsBlock(text: string): string {
  const idx = text.lastIndexOf(FENCE);
  if (idx === -1) return text;
  return text.slice(0, idx).trimEnd();
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
