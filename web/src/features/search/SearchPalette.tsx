/**
 * Cmd+K search palette. Modal overlay with a single text input + a list
 * of FTS hits. Debounced (180ms) to avoid hammering the API on every
 * keystroke. Up/Down/Enter/Esc keyboard navigation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

import { cn } from "@/lib/cn";
import { useFocusNode } from "@/app/navigation";
import { useWorkspaceUI } from "@/stores/workspaceUI";
import * as api from "@/lib/api";
import type { SearchHit } from "@/lib/types";

const DEBOUNCE_MS = 180;
const RESULT_LIMIT = 12;

export function SearchPalette() {
  const open = useWorkspaceUI((s) => s.searchPaletteOpen);
  const setOpen = useWorkspaceUI((s) => s.setSearchPalette);
  const focus = useFocusNode();

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state when the palette closes; auto-focus the input on open.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    } else {
      setQuery("");
      setHits([]);
      setSelectedIdx(0);
      setError(null);
    }
  }, [open]);

  // Debounced search. Cancels in-flight requests via an AbortController
  // bound to the effect's cleanup so out-of-order responses can't repaint
  // a stale result list.
  useEffect(() => {
    if (!open) return;
    if (!query.trim()) {
      setHits([]);
      setSelectedIdx(0);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        // The api wrapper doesn't take a signal yet; we still benefit
        // from the timer being cleared on rapid retypes.
        const next = await api.search({ q: query, k: RESULT_LIMIT });
        if (controller.signal.aborted) return;
        setHits(next);
        setSelectedIdx(0);
        setError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    }, DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, query]);

  const onPick = useCallback(
    async (hit: SearchHit) => {
      await focus(hit.id, hit.topic);
      setOpen(false);
    },
    [focus, setOpen],
  );

  const visibleHits = useMemo(() => hits.slice(0, RESULT_LIMIT), [hits]);

  if (!open) return null;
  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-start justify-center bg-forest-900/30 px-4 pt-32 backdrop-blur-sm",
        "animate-[fade-in_180ms_ease-out_both]",
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search nodes"
        className={cn(
          "shadow-soft border-forest-200 bg-sand-100 w-full max-w-xl overflow-hidden rounded-xl border",
          "animate-[scale-in_220ms_cubic-bezier(0.2,0.8,0.2,1)_both]",
        )}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelectedIdx((i) => Math.min(visibleHits.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelectedIdx((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            const hit = visibleHits[selectedIdx];
            if (hit) void onPick(hit);
          }
        }}
      >
        <div className="border-forest-100 flex items-center gap-3 border-b px-4 py-3">
          <Search size={18} strokeWidth={1.75} className="text-forest-400 flex-none" aria-hidden />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search nodes…"
            aria-label="Search query"
            className="placeholder:text-forest-300 w-full bg-transparent text-base text-forest-900 outline-none"
          />
        </div>
        <ul className="max-h-80 overflow-y-auto" role="listbox" aria-label="Search results">
          {visibleHits.length === 0 && query.trim() && !error && (
            <li className="text-forest-400 px-4 py-3 text-sm">No matches.</li>
          )}
          {error && (
            <li className="text-accent px-4 py-3 text-sm" role="alert">
              {error}
            </li>
          )}
          {visibleHits.map((h, i) => (
            <li key={h.id} role="option" aria-selected={i === selectedIdx}>
              <button
                type="button"
                onClick={() => void onPick(h)}
                onMouseEnter={() => setSelectedIdx(i)}
                className={cn(
                  "block w-full px-4 py-2 text-left transition-colors",
                  i === selectedIdx ? "bg-forest-100" : "hover:bg-forest-100/50",
                )}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate font-medium text-forest-800">{h.title}</span>
                  <span className="text-forest-400 shrink-0 text-[10px] uppercase tracking-[0.08em]">
                    {h.topic}
                  </span>
                </div>
                <p
                  className="text-forest-500 mt-0.5 line-clamp-1 text-sm"
                  // FTS5 snippet is sanitized server-side to only contain
                  // the `<b>` highlight markers; nothing else is parsed.
                  dangerouslySetInnerHTML={{ __html: h.snippet }}
                />
              </button>
            </li>
          ))}
        </ul>
        <footer className="text-forest-400 border-forest-100 flex items-center justify-between border-t px-4 py-2 text-[10px] uppercase tracking-[0.08em] tabular-nums">
          <span className="flex items-center gap-2">
            <kbd className="border-forest-200 bg-forest-50 rounded border px-1 py-0.5 normal-case tracking-normal">↑↓</kbd>
            navigate
            <span className="text-forest-200">·</span>
            <kbd className="border-forest-200 bg-forest-50 rounded border px-1 py-0.5 normal-case tracking-normal">↵</kbd>
            open
            <span className="text-forest-200">·</span>
            <kbd className="border-forest-200 bg-forest-50 rounded border px-1 py-0.5 normal-case tracking-normal">esc</kbd>
            close
          </span>
          <span>
            {visibleHits.length} hit{visibleHits.length === 1 ? "" : "s"}
          </span>
        </footer>
      </div>
    </div>
  );
}
