/**
 * Shared node-type chip + the canonical per-type label / tone tables.
 * Single source of truth for how a `NodeType` renders as a pill —
 * TreeView cards and the editor's TypePicker both consume this, so a
 * future taxonomy change touches one file on the styling side.
 *
 * The descriptions mirror the per-type writing guidance the agent gets
 * in `rust/crates/agent/src/prompt.rs` — keep the two in spirit-sync so
 * the human picker and the agent's auto-assignment agree on semantics.
 */

import { cn } from "@/lib/cn";
import type { NodeType } from "@/lib/types";

/** Display order for pickers — matches the enum order in domain. */
export const NODE_TYPES: NodeType[] = [
  "concept",
  "fact",
  "source",
  "example",
  "question",
  "task",
  "misc",
];

export const TYPE_LABEL: Record<NodeType, string> = {
  concept: "concept",
  fact: "fact",
  source: "source",
  example: "example",
  question: "question",
  task: "task",
  misc: "misc",
};

export const TYPE_TONE: Record<NodeType, string> = {
  concept: "bg-forest-100 text-forest-700",
  fact: "bg-sand-200 text-forest-700",
  source: "bg-rust-100 text-rust-700",
  example: "bg-rust-50 text-rust-700",
  question: "bg-forest-100 text-forest-600",
  task: "bg-forest-100 text-forest-700",
  misc: "bg-sand-200 text-forest-500",
};

export const TYPE_DESCRIPTION: Record<NodeType, string> = {
  concept: "An idea or building block, explained",
  fact: "A precise, checkable statement",
  source: "A citation or reference",
  example: "One concrete instance, walked through",
  question: "An open question to resolve",
  task: "Actionable steps to take",
  misc: "Anything that doesn't fit elsewhere",
};

export function TypeChip({ type, compact }: { type: NodeType; compact?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full font-medium uppercase tracking-[0.08em]",
        compact ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-0.5 text-[10px]",
        TYPE_TONE[type],
      )}
    >
      {TYPE_LABEL[type]}
    </span>
  );
}
