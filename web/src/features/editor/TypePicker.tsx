/**
 * Clickable node-type chip with a popover listbox. Lives on the
 * editor's metadata row — the agent assigns a type when it proposes a
 * node, but the human always gets the final say here.
 *
 * Hand-rolled popover (no headless-UI dependency in this codebase):
 * pointerdown-outside and Escape both close it; options are real
 * buttons so keyboard focus order works without extra wiring.
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/cn";
import { NODE_TYPES, TYPE_DESCRIPTION, TYPE_LABEL, TYPE_TONE } from "@/ui/TypeChip";
import type { NodeType } from "@/lib/types";

interface Props {
  value: NodeType;
  onChange: (t: NodeType) => void;
}

export function TypePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Node type: ${TYPE_LABEL[value]} — change`}
        title="Change node type"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex shrink-0 items-center gap-0.5 rounded-full py-0.5 pl-2 pr-1.5",
          "text-[10px] font-medium uppercase tracking-[0.08em] transition-shadow",
          "hover:ring-forest-300/60 hover:ring-1",
          TYPE_TONE[value],
        )}
      >
        {TYPE_LABEL[value]}
        <ChevronDown size={10} strokeWidth={2.5} aria-hidden className="opacity-60" />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label="Node type"
          className={cn(
            "border-forest-200 bg-sand-100 shadow-glass absolute left-0 top-full z-20 mt-1.5",
            "w-64 rounded-xl border p-1",
          )}
        >
          {NODE_TYPES.map((t) => {
            const selected = t === value;
            return (
              <li key={t}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    setOpen(false);
                    if (!selected) onChange(t);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                    selected ? "bg-forest-100/70" : "hover:bg-forest-100/40",
                  )}
                >
                  <span
                    className={cn(
                      // Fixed-width chip column so the description
                      // texts left-align down the list.
                      "inline-flex w-[4.5rem] shrink-0 items-center justify-center rounded-full px-1.5 py-0.5",
                      "text-[9px] font-medium uppercase tracking-[0.08em]",
                      TYPE_TONE[t],
                    )}
                  >
                    {TYPE_LABEL[t]}
                  </span>
                  <span className="text-forest-500 min-w-0 flex-1 truncate text-xs">
                    {TYPE_DESCRIPTION[t]}
                  </span>
                  {selected && (
                    <Check size={12} strokeWidth={2.5} aria-hidden className="text-forest-600 shrink-0" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
