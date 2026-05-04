/**
 * Breadcrumb — topic title → ancestor titles → current node.
 *
 * Walks the parent chain via `useForestData.nodes` (already cached when
 * the topic was loaded). If an ancestor is missing, we render a stub
 * label rather than firing a fetch storm; ancestors should be present
 * because `fetchTopic` populates the whole tree.
 */

import { useMemo } from "react";

import { cn } from "@/lib/cn";
import { useFocusNode } from "@/app/navigation";
import { useForestData } from "@/stores/forestData";
import type { Node, NodeId, TopicId } from "@/lib/types";

interface Props {
  nodeId: NodeId;
  topicId: TopicId;
}

interface Crumb {
  id: NodeId | TopicId;
  label: string;
  kind: "topic" | "node";
}

export function Breadcrumb({ nodeId, topicId }: Props) {
  const nodes = useForestData((s) => s.nodes);
  const topicDetails = useForestData((s) => s.topicDetails);
  const focusNode = useFocusNode();

  const crumbs = useMemo(() => buildCrumbs(nodeId, topicId, nodes, topicDetails), [
    nodeId,
    topicId,
    nodes,
    topicDetails,
  ]);

  return (
    <nav aria-label="Breadcrumb" className="text-forest-500 flex items-center gap-1 text-sm">
      {crumbs.map((c, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={`${c.kind}:${c.id}`} className="flex items-center gap-1">
            {c.kind === "node" && !isLast ? (
              <button
                type="button"
                onClick={() => void focusNode(c.id as NodeId, topicId)}
                className={cn(
                  "hover:text-forest-700 max-w-[16ch] truncate underline-offset-4 hover:underline",
                )}
                title={c.label}
              >
                {c.label}
              </button>
            ) : (
              <span
                className={cn("max-w-[16ch] truncate", isLast && "text-forest-800 font-medium")}
                title={c.label}
              >
                {c.label}
              </span>
            )}
            {!isLast && <span className="text-forest-300 select-none">/</span>}
          </span>
        );
      })}
    </nav>
  );
}

function buildCrumbs(
  nodeId: NodeId,
  topicId: TopicId,
  nodes: Record<NodeId, Node>,
  topicDetails: Record<TopicId, { title: string; root_node_id: NodeId; nodes: { id: NodeId; title: string }[] }>,
): Crumb[] {
  const detail = topicDetails[topicId];
  const crumbs: Crumb[] = [
    { id: topicId, label: detail?.title ?? topicId, kind: "topic" },
  ];

  // Walk parent chain. Use the topic detail's summaries when the node
  // isn't in `nodes` (only the focused node is fetched eagerly).
  const summaryById = new Map<NodeId, { id: NodeId; title: string; parent?: NodeId | null }>();
  if (detail) {
    for (const n of detail.nodes as Array<{ id: NodeId; title: string; parent: NodeId | null }>) {
      summaryById.set(n.id, n);
    }
  }

  const path: Crumb[] = [];
  const seen = new Set<NodeId>();
  let cursor: NodeId | null = nodeId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const fromCache: Node | undefined = nodes[cursor];
    const fromSummary = summaryById.get(cursor);
    const label = fromCache?.title ?? fromSummary?.title ?? cursor;
    path.unshift({ id: cursor, label, kind: "node" });
    const parentFromCache: NodeId | null = fromCache?.parent ?? null;
    const parentFromSummary: NodeId | null = fromSummary?.parent ?? null;
    cursor = parentFromCache ?? parentFromSummary ?? null;
  }

  // The topic root is the first crumb in `path`; we already prepended
  // the topic itself, so don't duplicate.
  if (path.length > 0 && detail && path[0]!.id === detail.root_node_id) {
    path.shift();
  }

  return [...crumbs, ...path];
}
