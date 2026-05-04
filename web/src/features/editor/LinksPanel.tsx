/**
 * Existing-links chips. Rendered as accent-tinted pills with a tiny
 * unlink button. Clicking the pill body navigates; clicking the × runs
 * the unlink mutation (which optimistically updates the editing node's
 * `links` array via `patchNode`).
 *
 * If a target id isn't in the cache yet, we render the suffix-of-id
 * placeholder rather than fetching — the user is unlikely to care about
 * the title until they hover, and we don't want to fan out N fetches
 * on first paint.
 */

import { useMemo } from "react";

import { cn } from "@/lib/cn";
import { useForestData } from "@/stores/forestData";
import { useWorkspaceUI } from "@/stores/workspaceUI";
import type { Node, NodeId } from "@/lib/types";

interface Props {
  node: Node;
  className?: string;
}

export function LinksPanel({ node, className }: Props) {
  const nodes = useForestData((s) => s.nodes);
  const topicDetails = useForestData((s) => s.topicDetails);
  const fetchNode = useForestData((s) => s.fetchNode);
  const patchNode = useForestData((s) => s.patchNode);
  const focusNode = useWorkspaceUI((s) => s.focusNode);

  const items = useMemo(
    () =>
      node.links.map((id) => {
        const cached = nodes[id];
        if (cached) return { id, title: cached.title, topic: cached.topic };
        for (const detail of Object.values(topicDetails)) {
          const sum = detail.nodes.find((n) => n.id === id);
          if (sum) return { id, title: sum.title, topic: detail.id };
        }
        return { id, title: `…${id.slice(-8)}`, topic: undefined };
      }),
    [node.links, nodes, topicDetails],
  );

  if (items.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {items.map((it) => (
        <span
          key={it.id}
          className="bg-sand-200/60 text-forest-700 inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs"
        >
          <button
            type="button"
            className="hover:text-accent max-w-[14ch] truncate underline-offset-4 hover:underline"
            onClick={() => {
              if (it.topic && !nodes[it.id]) {
                // Lazy load if we haven't fetched the full node yet.
                void fetchNode(it.id);
              }
              focusNode(it.id, it.topic);
            }}
            title={`${it.title}\n${it.id}`}
          >
            {it.title}
          </button>
          <button
            type="button"
            className="text-forest-400 hover:text-accent"
            aria-label={`Unlink ${it.title}`}
            onClick={() => {
              const next = node.links.filter((l: NodeId) => l !== it.id);
              void patchNode(node.id, { links: next });
            }}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
