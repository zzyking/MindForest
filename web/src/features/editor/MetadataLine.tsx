/**
 * Subtle metadata strip under the title: relative timestamps + the ULID
 * suffix (so users can find the markdown file on disk if they need to
 * grep for it). Pure display.
 */

import { cn } from "@/lib/cn";
import type { Node } from "@/lib/types";

interface Props {
  node: Node;
  className?: string;
}

export function MetadataLine({ node, className }: Props) {
  const created = new Date(node.created_at);
  const updated = new Date(node.updated_at);
  const sameInstant = +created === +updated;
  return (
    <div
      className={cn(
        "text-forest-400 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs",
        // Tabular nums so timestamps don't reflow as numbers tick; small
        // wide-tracking caps treat metadata as a label strip rather than
        // body copy.
        "tabular-nums uppercase tracking-[0.08em]",
        className,
      )}
    >
      <span title={created.toISOString()}>created {formatRelative(created)}</span>
      {!sameInstant && (
        <span title={updated.toISOString()}>
          <span className="text-forest-300 mx-1">·</span>
          updated {formatRelative(updated)}
        </span>
      )}
      <span className="text-forest-300">·</span>
      <span className="text-forest-300 font-mono normal-case tracking-normal" title={node.id}>
        {node.id.slice(-8)}
      </span>
    </div>
  );
}

function formatRelative(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 30) return `${diffD}d ago`;
  // Fallback to absolute date (locale: yyyy-mm-dd) for older entries.
  return d.toISOString().slice(0, 10);
}
