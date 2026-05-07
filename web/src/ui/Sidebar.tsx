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
import { ApiError } from "@/lib/api";
import type { NodeId, NodeSummary, TopicId } from "@/lib/types";

export function Sidebar() {
  const params = useParams({ strict: false }) as Partial<{ topicId: TopicId; nodeId: NodeId }>;
  const focusedTopicId = params.topicId;

  const topics = useForestData((s) => s.topics);
  const topicDetails = useForestData((s) => s.topicDetails);
  const fetchTopics = useForestData((s) => s.fetchTopics);
  const fetchTopic = useForestData((s) => s.fetchTopic);
  const createTopic = useForestData((s) => s.createTopic);

  const focus = useFocusNode();

  // Inline new-topic affordance. Tauri 2 disables window.prompt so we
  // do the input inline — autoFocus on open, Esc/blur cancels.
  const [creating, setCreating] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onCreateTopic = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const title = draftTitle.trim();
    if (!title || submitting) return;
    setSubmitting(true);
    setCreateError(null);
    try {
      const topic = await createTopic(title);
      setDraftTitle("");
      setCreating(false);
      await focus(topic.root_node_id, topic.id, { forestCameraMode: "topic-root" });
    } catch (err) {
      setCreateError(
        err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setSubmitting(false);
    }
  };

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
        <h2 className="text-forest-900 font-serif text-2xl font-medium tracking-tight leading-none">
          MindForest
        </h2>
        <p className="text-forest-400 mt-1.5 text-[10px] uppercase tracking-[0.12em] tabular-nums">
          {topicList.length} {topicList.length === 1 ? "topic" : "topics"}
        </p>
      </header>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-forest-500 text-[10px] font-medium uppercase tracking-wide">
            Topics
          </h3>
          <button
            type="button"
            aria-label="New topic"
            title="New topic"
            onClick={() => {
              setCreating(true);
              setCreateError(null);
            }}
            className="text-forest-400 hover:text-forest-700 inline-flex h-5 w-5 items-center justify-center rounded text-sm leading-none"
          >
            +
          </button>
        </div>
        {creating && (
          <form
            onSubmit={onCreateTopic}
            className="mb-2 flex items-center gap-1 px-1"
          >
            <input
              autoFocus
              type="text"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setCreating(false);
                  setDraftTitle("");
                  setCreateError(null);
                }
              }}
              placeholder="Topic title"
              disabled={submitting}
              className="border-forest-200 bg-sand-50 placeholder:text-forest-400 focus:border-forest-500 min-w-0 flex-1 rounded border px-2 py-0.5 text-xs focus:outline-none disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={!draftTitle.trim() || submitting}
              className="text-forest-600 hover:text-forest-900 disabled:text-forest-300 inline-flex h-6 items-center text-xs"
            >
              {submitting ? "…" : "Add"}
            </button>
          </form>
        )}
        {createError && (
          <p className="text-accent mb-1 px-2 text-[10px]">{createError}</p>
        )}
        <ul className="flex flex-col gap-0.5">
          {topicList.map((t) => {
            const active = t.id === focusedTopicId;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={async () => {
                    const detail = await fetchTopic(t.id);
                    await focus(detail.root_node_id, detail.id, {
                      forestCameraMode: "topic-root",
                    });
                  }}
                  className={cn(
                    "relative w-full truncate rounded px-2 py-1 pl-3 text-left text-sm font-semibold transition-colors",
                    "before:absolute before:left-0.5 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-full",
                    active
                      ? "bg-forest-100 text-forest-900 before:bg-accent"
                      : "text-forest-600 hover:bg-forest-100/50 before:bg-transparent",
                  )}
                  title={`${t.title} (${t.node_count} nodes)`}
                >
                  {t.title}
                </button>
              </li>
            );
          })}
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
    <ul className="flex flex-col">
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

  // Indent guide lines: one per ancestor depth, pinned through the
  // chevron column of that ancestor. Drawn as absolute spans inside the
  // row so they stack continuously between rows (no row-gap → no
  // visible breaks). Each chevron column is 1.5rem wide, sitting after
  // the row's 0.25rem padding-left + (depth × 0.75rem) indent step, so
  // the chevron centre at depth k lives at `k·0.75 + 1rem`.
  const guides = Array.from({ length: depth }, (_, k) => k);

  return (
    <li>
      <div
        className="group relative flex items-stretch text-sm text-forest-600"
        style={{ paddingLeft: `${depth * 0.75}rem` }}
      >
        {guides.map((k) => (
          <span
            key={k}
            aria-hidden
            className="bg-forest-200/50 pointer-events-none absolute top-0 bottom-0 w-px"
            style={{ left: `calc(${k * 0.75}rem + 0.5rem)` }}
          />
        ))}
        {/* Highlight surface starts where the chevron column begins,
            so the focused / hover bg never reaches left of the deepest
            ancestor's guide line. Right edge is flush with the sidebar
            inner padding (no -mr trick), matching the topic rows. */}
        <div
          className={cn(
            "relative flex w-full items-center gap-1 rounded transition-colors",
            "before:absolute before:left-0.5 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-full",
            isFocused
              ? "bg-forest-100 text-forest-900 before:bg-accent"
              : "hover:bg-forest-100/50 before:bg-transparent",
          )}
        >
          <button
            type="button"
            aria-label={children.length > 0 ? (isOpen ? "Collapse" : "Expand") : undefined}
            className={cn(
              "text-forest-500 hover:text-forest-800 inline-flex h-6 w-1 flex-none items-center justify-center text-base leading-none px-2",
              children.length === 0 && "invisible",
            )}
            onClick={() => toggle(node.id)}
            tabIndex={children.length > 0 ? 0 : -1}
          >
            {isOpen ? "▾" : "▸"}
          </button>
          <button
            type="button"
            onClick={() => {
              focus(node.id, topicId);
              if (children.length > 0 && !isOpen) {
                toggle(node.id);
              }
            }}
            className="min-w-0 flex-1 truncate py-1 text-left"
            title={node.title}
          >
            {node.title || "Untitled"}
          </button>
        </div>
      </div>
      {isOpen && children.length > 0 && (
        <ul className="flex flex-col">
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
