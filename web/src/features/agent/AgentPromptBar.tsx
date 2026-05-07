/**
 * Floating bottom-center prompt bar. Press `/` (or `Cmd+I`) anywhere in
 * the workspace to focus it; submit kicks off an agent stream and pops
 * the `DraftOverlay` automatically (the overlay is bound to the same
 * agent session store so we don't pass anything explicitly).
 *
 * The bar sits above the Dock, not inside it — Dock is intentionally
 * narrow + chip-shaped and an input would distort its rhythm.
 */

import { useEffect, useRef, useState } from "react";
import { useParams, useRouterState } from "@tanstack/react-router";

import { cn } from "@/lib/cn";
import { useAgentSession } from "./agentStore";

export function AgentPromptBar() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const streaming = useAgentSession((s) => s.streaming);
  const startStream = useAgentSession((s) => s.startStream);
  const cancel = useAgentSession((s) => s.cancel);

  // Pull the current topicId / nodeId out of the route so the user
  // doesn't have to retype them. The bar is mounted at the shell so
  // it's outside any specific route — read directly from the matches.
  const { topicId, focusedNodeId } = useCurrentRouteContext();

  // Slash-to-focus, Cmd+I as backup. Skip when an input already owns
  // focus so editor typing isn't hijacked.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const inEditable =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (cmd && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }
      if (!cmd && e.key === "/" && !inEditable) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || streaming || !topicId) return;
    const prompt = text.trim();
    setText("");
    await startStream({ topicId, focusedNodeId, prompt });
  };

  return (
    <form
      onSubmit={onSubmit}
      className="pointer-events-none absolute inset-x-0 bottom-20 flex justify-center"
    >
      <div
        className={cn(
          "shadow-glass border-forest-200 bg-sand-100/90 pointer-events-auto",
          "flex w-[min(620px,calc(100vw-2rem))] items-center gap-3 rounded-full border px-4 py-2 backdrop-blur-md",
        )}
      >
        <span className="text-forest-500 flex items-center gap-1 text-[10px] uppercase tracking-[0.12em]">
          <SparkGlyph />
          Agent
        </span>
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
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
            className="text-sand-100 bg-rust-600 hover:bg-rust-700 rounded-full px-3 py-1 text-xs transition-colors"
          >
            Cancel
          </button>
        ) : (
          <button
            type="submit"
            disabled={!text.trim() || !topicId}
            className={cn(
              "text-sand-100 rounded-full px-3 py-1 text-xs transition-colors",
              "bg-forest-700 hover:bg-forest-800",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            Send
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * Tiny three-stroke spark — sits next to the "Agent" label so the
 * prompt bar reads as agentic rather than a generic input. Hand-drawn
 * feel matches the rest of the chrome's Unicode-glyph aesthetic.
 */
function SparkGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="opacity-80"
    >
      <path d="M6 1 L6 5" />
      <path d="M6 7 L6 11" />
      <path d="M1 6 L4 6" />
      <path d="M8 6 L11 6" />
      <circle cx="6" cy="6" r="1" />
    </svg>
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
  // Prefer the deepest match's params — that's the one with topicId / nodeId.
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i];
    if (!match) continue;
    const params = match.params as { topicId?: string; nodeId?: string };
    if (params?.topicId) {
      return { topicId: params.topicId, focusedNodeId: params.nodeId ?? null };
    }
  }
  // Fall back to useParams in case the matches selector misses something.
  const params = useParamsCompat();
  return {
    topicId: params.topicId ?? null,
    focusedNodeId: params.nodeId ?? null,
  };
}

// Wrapping useParams so the typing matches both index + nested routes.
function useParamsCompat() {
  return useParams({ strict: false }) as {
    topicId?: string;
    nodeId?: string;
  };
}
