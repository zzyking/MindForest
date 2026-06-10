/**
 * Conversation panel that rises from the AgentPromptBar: streaming
 * prose and prior turns at the top, structured proposals below with
 * accept / reject affordances. Same width and same main-pane axis as
 * the bar, so prompt + reply read as one surface (the input is the
 * bottom edge of the conversation). Esc / ✕ only HIDE the panel — the
 * conversation survives and the next prompt (or reopening the agent
 * surface) brings it back; the header's Clear is the explicit end of
 * a session. We don't auto-close on Done so the user has time to
 * decide on each proposal.
 *
 * Accept order matters when proposals reference each other through
 * `client_id` placeholders, so the overlay accepts in array order and
 * threads the resolution table forward. Accepts target the session's
 * topic (`sessionTopicId`), not the current route — the user may have
 * navigated elsewhere since the proposals were generated.
 */

import { useEffect, useRef, useState } from "react";

import { useMainPaneShiftClass } from "@/app/mainPaneShift";
import { cn } from "@/lib/cn";
import { useWorkspaceUI } from "@/stores/workspaceUI";
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
  const reset = useAgentSession((s) => s.reset);
  const setProposalStatus = useAgentSession((s) => s.setProposalStatus);
  const resolvedTable = useAgentSession((s) => s.resolvedTable);
  const mergeResolvedTable = useAgentSession((s) => s.mergeResolvedTable);
  const sessionTopicId = useAgentSession((s) => s.sessionTopicId);
  // The panel is part of the agent surface: it only shows while the
  // prompt bar shows, so collapsing the bar (or the whole dock) can't
  // leave a conversation floating with no input under it.
  const dockExpanded = useWorkspaceUI((s) => s.dockExpanded);
  const agentBarOpen = useWorkspaceUI((s) => s.agentBarOpen);
  const [bulkBusy, setBulkBusy] = useState(false);
  const shift = useMainPaneShiftClass();
  const visible = open && dockExpanded && agentBarOpen;

  // ESC hides the panel (parallel to the ✕ button); the session
  // survives — see agentStore.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, close]);

  // Pin-to-bottom scroll: while the reader is at (or near) the bottom,
  // new tokens / turns / proposals keep the newest content in view;
  // scrolling up to re-read releases the pin until they return.
  const scrollRef = useRef<HTMLElement | null>(null);
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [draft, history, proposals, errors, streaming]);

  if (!visible) return null;

  const acceptOne = async (entry: ProposalEntry, table: ResolveTable): Promise<ResolveTable> => {
    if (entry.status !== "pending" || !sessionTopicId) return table;
    // Merge the store's accumulated table with the local threading table so
    // individual-card accepts can resolve client_ids created earlier in the
    // same session, not just within a single acceptAll run.
    const base = { ...resolvedTable, ...table };
    try {
      const next = await applyProposal(entry.proposal, sessionTopicId, base);
      setProposalStatus(entry.id, "accepted");
      mergeResolvedTable(next);
      return { ...table, ...next };
    } catch (e) {
      setProposalStatus(entry.id, "failed", errorMessage(e));
      return table;
    }
  };

  const acceptAll = async () => {
    if (!sessionTopicId) return;
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
    // Two-element split, same trick as the bar: the outer wrapper owns
    // the sidebar-tracking translate-x, the inner panel owns the
    // entrance keyframe — both write `transform`, and a fill-mode:both
    // animation on one element would permanently override the other.
    // bottom-36 clears the prompt bar (form bottom-20 + ~52px pill)
    // with the same ~14px breath the bar keeps above the dock.
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-36 z-40 flex justify-center",
        "transition-transform duration-[350ms] ease-out resize-keep-transform will-change-transform",
        shift,
      )}
    >
      {/* Not role="dialog": this is a non-modal companion panel. The
          user keeps editing the main pane while it's open, so trapping
          focus here would actively hurt the flow. aria-label is enough
          to land landmark-navigation users on it. */}
      <aside
        aria-label="Agent draft"
        className={cn(
          "pointer-events-auto flex max-h-[min(60vh,40rem)] w-[min(620px,calc(100vw-2rem))] flex-col",
          "shadow-glass border-forest-200 bg-sand-50/95 rounded-2xl border backdrop-blur-md",
          "animate-[draft-rise_260ms_cubic-bezier(0.2,0.8,0.2,1)_both]",
        )}
      >
        <header className="border-forest-100 flex items-center justify-between border-b px-4 py-3">
          <div>
            <div className="text-forest-500 text-[10px] uppercase tracking-wider">Agent draft</div>
            {/* In-flight prompt, else the last committed one (prompt is
                cleared when a turn lands in history). */}
            <div className="text-forest-900 line-clamp-1 text-sm">
              {prompt || lastUserPrompt(history) || "—"}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* Clear ends the session (aborts + wipes history); ✕ only
                hides the panel and the conversation continues. */}
            <button
              type="button"
              onClick={reset}
              className="text-forest-500 hover:text-forest-800 rounded-full px-2 py-0.5 text-xs"
              aria-label="Clear conversation"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={close}
              className="text-forest-500 hover:text-forest-800 rounded-full px-2 py-0.5 text-xs"
              aria-label="Hide draft"
            >
              ✕
            </button>
          </div>
        </header>

        {/* min-h-0: inside the max-h flex column the scroll area must
            be allowed to shrink below its content, or long sessions
            push the footer past the panel edge instead of scrolling. */}
        <section
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current;
            if (!el) return;
            pinnedRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        >
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
          {/* Active (in-flight or failed-uncommitted) turn. A finished
              turn moves to history and clears prompt/draft, so `prompt`
              doubles as the "an uncommitted turn exists" flag — without
              it the committed turn would render twice. aria-live lets
              screen readers announce streamed tokens and the proposal list
              as it materialises. aria-busy flips off when streaming ends
              so the reader knows the response is final. */}
          {(streaming || draft || prompt) && (
            <div
              aria-live="polite"
              aria-atomic="false"
              aria-busy={streaming}
              className="border-forest-100 flex flex-col gap-2 border-t pt-3"
            >
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
            <div
              role="alert"
              className="mt-3 rounded-md border border-rust-300 bg-rust-50 px-3 py-2 text-xs text-rust-800"
            >
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
            disabled={bulkBusy || streaming || proposals.every((p) => p.status !== "pending") || !sessionTopicId}
            className="text-sand-100 bg-forest-700 hover:bg-forest-800 disabled:opacity-40 rounded-full px-3 py-1 text-xs"
          >
            {bulkBusy ? "Applying…" : "Accept all"}
          </button>
        </footer>
      </aside>
    </div>
  );
}

function lastUserPrompt(
  history: { role: "user" | "assistant"; text: string }[],
): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const t = history[i];
    if (t?.role === "user") return t.text;
  }
  return null;
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
