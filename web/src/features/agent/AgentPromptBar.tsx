/**
 * Floating prompt bar that expands above the Dock on demand. At rest it
 * collapses to nothing — the dock's Sparkles trigger, `/`, or ⌘I opens
 * it (`agentBarOpen` in workspaceUI) and focuses the input; Esc
 * collapses it and hands focus back to wherever it came from. Submit
 * kicks off an agent stream and pops the `DraftOverlay` automatically
 * (the overlay is bound to the same agent session store so we don't
 * pass anything explicitly).
 *
 * The expanded bar sits above the Dock, not inside it — Dock is
 * intentionally narrow + chip-shaped and an input would distort its
 * rhythm. The bar stays mounted while hidden so a half-typed prompt
 * survives a collapse/expand round-trip.
 */

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { useParams, useRouterState } from "@tanstack/react-router";

import { useMainPaneShiftClass } from "@/app/mainPaneShift";
import { cn } from "@/lib/cn";
import { useWorkspaceUI } from "@/stores/workspaceUI";
import { useAgentSession } from "./agentStore";

export function AgentPromptBar() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const streaming = useAgentSession((s) => s.streaming);
  const startStream = useAgentSession((s) => s.startStream);
  const cancel = useAgentSession((s) => s.cancel);
  const dockExpanded = useWorkspaceUI((s) => s.dockExpanded);
  const agentBarOpen = useWorkspaceUI((s) => s.agentBarOpen);
  const setAgentBar = useWorkspaceUI((s) => s.setAgentBar);
  // Visible only when the chrome row itself is out AND the bar was
  // explicitly opened — at rest the dock is the only chrome row.
  const visible = dockExpanded && agentBarOpen;

  // Pull the current topicId / nodeId out of the route so the user
  // doesn't have to retype them. The bar is mounted at the shell so
  // it's outside any specific route — read directly from the matches.
  const { topicId, focusedNodeId } = useCurrentRouteContext();

  // Slash-to-open, Cmd+I as backup. Skip `/` when an input already owns
  // focus so editor typing isn't hijacked.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const inEditable =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      const wantsBar =
        (cmd && (e.key === "i" || e.key === "I")) ||
        (!cmd && e.key === "/" && !inEditable);
      if (!wantsBar) return;
      e.preventDefault();
      // Read fresh state — this handler registers once and closure
      // values from the render would go stale.
      const ui = useWorkspaceUI.getState();
      if (!ui.dockExpanded) ui.expandDock();
      if (!ui.agentBarOpen) {
        // Focus happens in the open effect below, after the commit
        // that lifts `inert` off the bar.
        ui.setAgentBar(true);
      } else {
        // Already open (possibly just un-hidden by expandDock above) —
        // wait for the commit, then focus directly.
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Whatever opened the bar (dock trigger, `/`, ⌘I), focus the input
  // and remember where focus came from so Esc can hand it back. Runs
  // after the commit, so `inert` has already been lifted.
  const prevFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!agentBarOpen) return;
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
  }, [agentBarOpen]);

  const close = () => {
    const prev = prevFocusRef.current;
    if (prev?.isConnected) prev.focus();
    setAgentBar(false);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || streaming || !topicId) return;
    const prompt = text.trim();
    setText("");
    await startStream({ topicId, focusedNodeId, prompt });
  };

  // Horizontal shift tracks the main-pane axis (shared with Dock and
  // DraftOverlay — see app/mainPaneShift.ts). Vertical shift handles
  // open/close. (The old 75ms dock-stagger is gone: the bar now mostly
  // opens alone, where a delay reads as input latency rather than
  // choreography.) Two concerns stay split onto separate elements so
  // the open/close tween never bleeds onto the sidebar-tracking
  // transform mid-flight.
  const horizontalShift = useMainPaneShiftClass();
  const verticalShift = visible
    ? "translate-y-0 opacity-100"
    : "translate-y-4 opacity-0 pointer-events-none";

  return (
    <form
      onSubmit={onSubmit}
      // inert: pointer-events-none alone would leave the hidden input
      // keyboard-tabbable; inert removes it from tab order + AT.
      inert={!visible}
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-20 flex justify-center will-change-transform",
        // 350ms matches the sidebar grid + dock transitions so the
        // three finish in lockstep when the sidebar toggles.
        // `resize-keep-transform` exempts this tween from the
        // data-resizing freeze so crossing the lg breakpoint mid
        // window-drag still animates (globals.css).
        "transition-transform duration-[350ms] ease-out resize-keep-transform",
        horizontalShift,
      )}
    >
      <div
        className={cn(
          "transition-all duration-300 ease-out will-change-transform",
          verticalShift,
        )}
      >
        <div
          className={cn(
            "shadow-glass border-forest-200 bg-sand-100/90 pointer-events-auto",
            "flex w-[min(620px,calc(100vw-2rem))] items-center gap-3 rounded-full border px-4 py-2 backdrop-blur-md",
          )}
        >
          <span className="text-forest-500 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em]">
            <Sparkles size={12} strokeWidth={2} aria-hidden />
            Agent
          </span>
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // Layered dismiss: while the draft panel is open this
                // Esc belongs to it (its window-level handler closes
                // it as the event bubbles past us); the next Esc
                // collapses the bar.
                if (useAgentSession.getState().open) return;
                e.preventDefault();
                close();
              }
            }}
            placeholder={
              topicId
                ? "Ask the agent to refine, expand, or restructure…"
                : "Open a topic to use the agent"
            }
            disabled={streaming || !topicId}
            aria-label="Agent prompt"
            className={cn(
              "flex-1 bg-transparent text-sm placeholder:text-forest-400 focus:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          />
          {streaming ? (
            <button
              type="button"
              onClick={cancel}
              className="text-sand-100 bg-rust-600 hover:bg-rust-700 rounded-full px-3 py-1.5 text-xs transition-colors"
            >
              Cancel
            </button>
          ) : (
            <button
              type="submit"
              disabled={!text.trim() || !topicId}
              className={cn(
                "text-sand-100 rounded-full px-3 py-1.5 text-xs transition-colors",
                "bg-forest-700 hover:bg-forest-800",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

/**
 * Pull `topicId` / `nodeId` out of the active route match, regardless
 * of which deep route is currently mounted. The match params shape is
 * `{ topicId?: string, nodeId?: string }` — both are optional because
 * the index route has neither.
 */
function useCurrentRouteContext(): {
  topicId: string | null;
  focusedNodeId: string | null;
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
