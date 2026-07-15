/**
 * `/$topicId/$nodeId` route — workspace home.
 *
 * L1: the field (ForestView) is always mounted. Writing is Inspect —
 * NodeEditor in a centered overlay when `?w=1` is present. Open/close
 * lives entirely in the URL (see navigation.ts); this page owns the
 * Enter / Esc keyboard loop and the scrim click.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";

import {
  useCloseInspect,
  useInspectOpen,
  useOpenInspect,
} from "@/app/navigation";
import { ForestView, getFocusedNodeViewportPoint } from "@/features/forest/ForestView";
import { NodeEditor } from "@/features/editor/NodeEditor";
import { cn } from "@/lib/cn";
import type { NodeId, TopicId } from "@/lib/types";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  // CodeMirror contenteditable surface
  if (el.closest(".cm-editor, .cm-content")) return true;
  return false;
}

export function NodePage() {
  // Loose-typed because rootRoute mounts before route generics resolve;
  // the values are guaranteed by the route path so we narrow with `as`.
  const { topicId, nodeId } = useParams({ strict: false }) as {
    topicId: TopicId;
    nodeId: NodeId;
  };
  const inspectOpen = useInspectOpen();
  const openInspect = useOpenInspect();
  const closeInspect = useCloseInspect();

  // Origin for the entrance animation (viewport coords relative to main).
  // Captured when Inspect opens; used as CSS transform-origin.
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const fieldHostRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);

  // Capture origin when Inspect transitions closed → open.
  useEffect(() => {
    if (inspectOpen && !wasOpenRef.current) {
      const host = fieldHostRef.current;
      const pt = getFocusedNodeViewportPoint(nodeId);
      if (host && pt) {
        const rect = host.getBoundingClientRect();
        setOrigin({ x: pt.x - rect.left, y: pt.y - rect.top });
      } else if (host) {
        const rect = host.getBoundingClientRect();
        setOrigin({ x: rect.width / 2, y: rect.height / 2 });
      } else {
        setOrigin(null);
      }
    }
    if (!inspectOpen) {
      setOrigin(null);
    }
    wasOpenRef.current = inspectOpen;
  }, [inspectOpen, nodeId]);

  // Focus the panel when Inspect opens (a11y); restore main on close.
  useEffect(() => {
    if (inspectOpen) {
      // Defer so the panel is in the DOM.
      const t = window.setTimeout(() => {
        panelRef.current?.focus({ preventScroll: true });
      }, 0);
      return () => window.clearTimeout(t);
    }
    const main = document.getElementById("main-content");
    main?.focus({ preventScroll: true });
  }, [inspectOpen]);

  // Enter opens Inspect (when closed, not typing); Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !inspectOpen) {
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        openInspect();
        return;
      }
      if (e.key === "Escape" && inspectOpen) {
        // Let nested dialogs (search, agent settings) claim Esc first —
        // they mount above and stop propagation when open. If we're
        // here, close Inspect.
        if (isTypingTarget(e.target)) {
          // Esc in an input blurs; still close Inspect only if not in
          // a modal. Simple rule: always close Inspect on Esc when open
          // unless a higher modal is open (search palette checks its own).
        }
        e.preventDefault();
        closeInspect();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inspectOpen, openInspect, closeInspect]);

  const onScrimClick = useCallback(() => {
    closeInspect();
  }, [closeInspect]);

  const reduce = prefersReducedMotion();
  const transformOrigin =
    origin != null ? `${origin.x}px ${origin.y}px` : "50% 50%";

  return (
    <div ref={fieldHostRef} className="relative h-full min-h-0">
      {/* Field — always mounted. Bokeh when Inspect open. */}
      <div
        className={cn(
          "h-full min-h-0",
          inspectOpen && "pointer-events-none select-none",
          inspectOpen &&
            "opacity-40 blur-[6px] saturate-50 contrast-90 transition-[opacity,filter] duration-300 ease-out",
          !inspectOpen && "opacity-100 blur-0 transition-[opacity,filter] duration-300 ease-out",
          reduce && inspectOpen && "blur-none opacity-50",
        )}
        aria-hidden={inspectOpen}
      >
        <ForestView focusedTopicId={topicId} focusedNodeId={nodeId} />
      </div>

      {inspectOpen && (
        <>
          {/* Inert scrim — click closes Inspect */}
          <button
            type="button"
            aria-label="Close inspect"
            className={cn(
              "absolute inset-0 z-20 cursor-default border-0 bg-forest-900/25",
              "animate-[fade-in_180ms_ease-out_both]",
              reduce && "animate-none",
            )}
            onClick={onScrimClick}
          />

          {/* Inspect panel — centered; enters from node origin */}
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Inspect node"
            tabIndex={-1}
            className={cn(
              "absolute inset-0 z-30 flex items-stretch justify-center p-3 sm:p-6",
              "pointer-events-none",
            )}
          >
            <div
              className={cn(
                "pointer-events-auto flex h-full w-full max-w-3xl flex-col overflow-hidden",
                "rounded-2xl border border-forest-200 bg-sand-100/95 shadow-soft backdrop-blur-md",
                "[-webkit-font-smoothing:antialiased] will-change-transform",
                reduce
                  ? "animate-[fade-in_160ms_ease-out_both]"
                  : "animate-[inspect-in_320ms_cubic-bezier(0.2,0.8,0.2,1)_both]",
              )}
              style={{ transformOrigin }}
            >
              <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                <NodeEditor key={`${topicId}/${nodeId}`} nodeId={nodeId} topicId={topicId} />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
