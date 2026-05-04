/**
 * Left sidebar. Topic list at the top, expandable node tree for the
 * current topic below.
 *
 * The node tree is a recursive list — not the d3 viz (P2). Each row
 * shows a chevron + title; clicking the title navigates, clicking the
 * chevron toggles expansion locally. Expansion state is per-mount and
 * intentionally not persisted — we'll revisit if usage data shows
 * users want it remembered.
 */

import { useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";

import { cn } from "@/lib/cn";
import { useFocusNode } from "@/app/navigation";
import { useForestData } from "@/stores/forestData";
import type { NodeId, NodeSummary, TopicId } from "@/lib/types";

export function Sidebar() {
  const params = useParams({ strict: false }) as Partial<{ topicId: TopicId; nodeId: NodeId }>;
  const focusedTopicId = params.topicId;

  const topics = useForestData((s) => s.topics);
  const topicDetails = useForestData((s) => s.topicDetails);
  const fetchTopics = useForestData((s) => s.fetchTopics);
  const fetchTopic = useForestData((s) => s.fetchTopic);

  const focus = useFocusNode();

  // Hydrate topic list once on mount.
  // We don't gate on `topics.length` because retries on transient errors
  // are useful, and `fetchTopics` is idempotent.
  useMemo(() => {
    void fetchTopics();
    // run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pre-fetch the focused topic's detail so the node tree renders
  // immediately. Idempotent call; the store's loading flag dedupes.
  useMemo(() => {
    if (focusedTopicId && !topicDetails[focusedTopicId]) {
      void fetchTopic(focusedTopicId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedTopicId]);

  const topicList = Object.values(topics).sort((a, b) => a.id.localeCompare(b.id));
  const focusedDetail = focusedTopicId ? topicDetails[focusedTopicId] : undefined;

  return (
    <div className="flex h-full flex-col gap-4 px-4 py-5">
      <header>
        <h2 className="font-serif text-xl tracking-tight text-forest-800">MindForest</h2>
        <p className="text-forest-400 mt-1 text-xs">{topicList.length} topics</p>
      </header>

      <section>
        <h3 className="text-forest-500 mb-2 text-[10px] font-medium uppercase tracking-wide">
          Topics
        </h3>
        <ul className="flex flex-col gap-0.5">
          {topicList.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={async () => {
                  const detail = await fetchTopic(t.id);
                  await focus(detail.root_node_id, detail.id);
                }}
                className={cn(
                  "w-full truncate rounded px-2 py-1 text-left text-sm",
                  t.id === focusedTopicId
                    ? "bg-forest-100 text-forest-800"
                    : "text-forest-600 hover:bg-forest-100/50",
                )}
                title={`${t.title} (${t.node_count} nodes)`}
              >
                {t.title}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {focusedDetail && (
        <section className="min-h-0 flex-1 overflow-y-auto">
          <h3 className="text-forest-500 mb-2 text-[10px] font-medium uppercase tracking-wide">
            Nodes
          </h3>
          <NodeTree
            nodes={focusedDetail.nodes}
            rootId={focusedDetail.root_node_id}
            topicId={focusedDetail.id}
            focusedNodeId={params.nodeId ?? null}
          />
        </section>
      )}
    </div>
  );
}

interface NodeTreeProps {
  nodes: NodeSummary[];
  rootId: NodeId;
  topicId: TopicId;
  focusedNodeId: NodeId | null;
}

function NodeTree({ nodes, rootId, topicId, focusedNodeId }: NodeTreeProps) {
  // Build adjacency: parent → children, sorted by id (ULID is time-sorted
  // so this matches creation order — good enough until manual reordering
  // exists).
  const childrenByParent = useMemo(() => {
    const map = new Map<NodeId | null, NodeSummary[]>();
    for (const n of nodes) {
      const arr = map.get(n.parent) ?? [];
      arr.push(n);
      map.set(n.parent, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.id.localeCompare(b.id));
    return map;
  }, [nodes]);

  // Auto-expand ancestors of the focused node so the user can see where
  // they are. Built into initial state so the *first* render is correct;
  // user collapses persist after that.
  const [expanded, setExpanded] = useState<Set<NodeId>>(() => {
    const out = new Set<NodeId>();
    if (!focusedNodeId) return out;
    const byId = new Map(nodes.map((n) => [n.id, n] as const));
    let cursor: NodeId | null = focusedNodeId;
    while (cursor) {
      out.add(cursor);
      const parent: NodeId | null = byId.get(cursor)?.parent ?? null;
      cursor = parent;
    }
    return out;
  });

  const toggle = (id: NodeId) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ul className="flex flex-col gap-0.5">
      <NodeRow
        node={nodes.find((n) => n.id === rootId)!}
        depth={0}
        childrenByParent={childrenByParent}
        topicId={topicId}
        focusedNodeId={focusedNodeId}
        expanded={expanded}
        toggle={toggle}
      />
    </ul>
  );
}

interface NodeRowProps {
  node: NodeSummary;
  depth: number;
  childrenByParent: Map<NodeId | null, NodeSummary[]>;
  topicId: TopicId;
  focusedNodeId: NodeId | null;
  expanded: Set<NodeId>;
  toggle: (id: NodeId) => void;
}

function NodeRow({
  node,
  depth,
  childrenByParent,
  topicId,
  focusedNodeId,
  expanded,
  toggle,
}: NodeRowProps) {
  const focus = useFocusNode();
  const children = childrenByParent.get(node.id) ?? [];
  const isOpen = expanded.has(node.id);
  const isFocused = node.id === focusedNodeId;

  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-1 rounded text-sm",
          isFocused
            ? "bg-forest-100 text-forest-800"
            : "text-forest-600 hover:bg-forest-100/50",
        )}
        style={{ paddingLeft: `${depth * 0.75 + 0.25}rem` }}
      >
        <button
          type="button"
          aria-label={children.length > 0 ? (isOpen ? "Collapse" : "Expand") : undefined}
          className={cn(
            "text-forest-400 hover:text-forest-600 inline-flex h-5 w-5 items-center justify-center text-[10px]",
            children.length === 0 && "invisible",
          )}
          onClick={() => toggle(node.id)}
          tabIndex={children.length > 0 ? 0 : -1}
        >
          {isOpen ? "▾" : "▸"}
        </button>
        <button
          type="button"
          onClick={() => focus(node.id, topicId)}
          className="min-w-0 flex-1 truncate py-1 text-left"
          title={node.title}
        >
          {node.title || "Untitled"}
        </button>
      </div>
      {isOpen && children.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {children.map((c) => (
            <NodeRow
              key={c.id}
              node={c}
              depth={depth + 1}
              childrenByParent={childrenByParent}
              topicId={topicId}
              focusedNodeId={focusedNodeId}
              expanded={expanded}
              toggle={toggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
