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

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";

import { cn } from "@/lib/cn";
import { useFocusNode } from "@/app/navigation";
import { useForestData } from "@/stores/forestData";
import { useAgentStatus } from "@/features/agent/useAgentStatus";
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

  const backend = useAgentStatus();
  const backendLabel = backend?.split(" (")[0] ?? null;
  const isStub = !backend || backend === "stub";

  return (
    // Floating panel shell owns outer chrome (WorkspaceShell). Inner
    // padding only — width is 100% of the panel, not a second sidebar
    // column. pt-4 is enough inside the rounded card (outer pt-10
    // already clears traffic lights).
    <div className="flex h-full w-full flex-col gap-4 overflow-hidden px-4 pb-5 pt-4">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-forest-900 font-serif text-2xl font-medium tracking-tight leading-none">
          MindForest
        </h2>
        <p className="text-forest-400 -translate-y-0.5 text-[10px] uppercase tracking-[0.12em] tabular-nums">
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
            className="text-forest-400 hover:text-forest-700 hover:bg-forest-100/60 inline-flex h-7 w-7 items-center justify-center rounded text-base leading-none"
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
        // Heading is pinned outside the scroll area so the virtualized
        // list is the sole child of the scroll element (the virtualizer's
        // scrollElement) — no scrollMargin bookkeeping for preceding
        // content.
        <section className="flex min-h-0 flex-1 flex-col">
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

      <footer className="mt-auto pt-2 border-t border-forest-100">
        <div className="flex items-center gap-2 px-1">
          <span
            className={cn(
              "h-1.5 w-1.5 flex-none rounded-full",
              isStub ? "bg-forest-300" : "bg-emerald-500 shadow-[0_0_4px_1px_rgba(52,211,153,0.5)]",
            )}
            aria-hidden
          />
          <span className="text-forest-400 truncate text-[10px]">
            {backendLabel ?? "…"}
          </span>
        </div>
      </footer>
    </div>
  );
}

interface NodeTreeProps {
  nodes: NodeSummary[];
  rootId: NodeId;
  topicId: TopicId;
  focusedNodeId: NodeId | null;
}

// One visible tree row, flattened out of the recursive structure so the
// list can be virtualized. `depth` drives the indent; `hasChildren` /
// `isOpen` drive the chevron.
interface FlatRow {
  node: NodeSummary;
  depth: number;
  hasChildren: boolean;
  isOpen: boolean;
}

// Fallback row height before measurement kicks in. Rows are single-line
// (truncated title, `py-1` + text-sm ≈ 26px); measureElement refines the
// real value per row, so this only affects the very first paint.
const ROW_HEIGHT = 28;

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

  // Auto-expand the focused node's ancestor chain whenever focus moves.
  // An effect rather than a one-shot useState initializer: the tree
  // mounts mid route-transition (focusedNodeId may not be resolved
  // yet) and the same instance is reused across topic switches, so
  // initial state alone misses both cases. User collapses elsewhere
  // are preserved — we only ever add the focused chain.
  const [expanded, setExpanded] = useState<Set<NodeId>>(new Set());
  useEffect(() => {
    if (!focusedNodeId) return;
    setExpanded((prev) => {
      const byId = new Map(nodes.map((n) => [n.id, n] as const));
      const additions: NodeId[] = [];
      let cursor: NodeId | null = focusedNodeId;
      const seen = new Set<NodeId>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        if (!prev.has(cursor)) additions.push(cursor);
        cursor = byId.get(cursor)?.parent ?? null;
      }
      if (additions.length === 0) return prev;
      const next = new Set(prev);
      for (const id of additions) next.add(id);
      return next;
    });
  }, [focusedNodeId, nodes]);

  const toggle = (id: NodeId) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Flatten the visible tree (root + expanded descendants) into a linear
  // DFS-ordered list. Collapsed subtrees never enter it — mirroring the
  // old "collapsed children don't mount" behaviour — so virtualization
  // caps mounted DOM to the visible window regardless of total node count.
  const rows = useMemo<FlatRow[]>(() => {
    const root = nodes.find((n) => n.id === rootId);
    if (!root) return [];
    const out: FlatRow[] = [];
    const walk = (node: NodeSummary, depth: number) => {
      const kids = childrenByParent.get(node.id) ?? [];
      const isOpen = expanded.has(node.id);
      out.push({ node, depth, hasChildren: kids.length > 0, isOpen });
      if (isOpen) for (const c of kids) walk(c, depth + 1);
    };
    walk(root, 0);
    return out;
  }, [nodes, rootId, childrenByParent, expanded]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (index) => rows[index]?.node.id ?? index,
  });

  // Keep the focused row in view when focus lands on a node that may be
  // outside the rendered window. The ancestor chain is auto-expanded
  // above, so the row exists in `rows` (possibly a render later, once the
  // expansion state settles). A ref gates this to once per focus change:
  // unrelated expand/collapse mutate `rows` but must not yank the scroll
  // position back to the focused row.
  const scrolledFor = useRef<NodeId | null>(null);
  useEffect(() => {
    if (!focusedNodeId) return;
    if (scrolledFor.current === focusedNodeId) return;
    const idx = rows.findIndex((r) => r.node.id === focusedNodeId);
    if (idx < 0) return; // ancestors still expanding — retry on next rows change
    scrolledFor.current = focusedNodeId;
    virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [focusedNodeId, rows, virtualizer]);

  return (
    // `scrollbar-gutter: stable` so rows don't narrow-shift when the tree
    // grows past the viewport and the (classic) scrollbar appears.
    // Single-edge: content is left-aligned, a left gutter would just
    // waste column width. This div is the virtualizer's scrollElement.
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
    >
      <div
        role="tree"
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          if (!row) return null; // count tracks rows.length; guards the index type
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vi.start}px)`,
              }}
            >
              <NodeRow
                row={row}
                topicId={topicId}
                focused={row.node.id === focusedNodeId}
                onToggle={toggle}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface NodeRowProps {
  row: FlatRow;
  topicId: TopicId;
  focused: boolean;
  onToggle: (id: NodeId) => void;
}

function NodeRow({ row, topicId, focused, onToggle }: NodeRowProps) {
  const { node, depth, hasChildren, isOpen } = row;
  const focus = useFocusNode();
  const prefetchNode = useForestData((s) => s.prefetchNode);

  // Indent guide lines: one per ancestor depth, pinned through the
  // chevron column of that ancestor. Drawn as absolute spans inside the
  // row so they stack continuously between rows (virtual rows sit at
  // contiguous cumulative offsets → no visible breaks). Each chevron
  // column is 1.5rem wide, sitting after the row's 0.25rem padding-left +
  // (depth × 0.75rem) indent step, so the chevron centre at depth k lives
  // at `k·0.75 + 1rem`.
  const guides = Array.from({ length: depth }, (_, k) => k);

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? isOpen : undefined}
      aria-selected={focused}
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
          focused
            ? "bg-forest-100 text-forest-900 before:bg-accent"
            : "hover:bg-forest-100/50 before:bg-transparent",
        )}
      >
        <button
          type="button"
          aria-label={hasChildren ? (isOpen ? "Collapse" : "Expand") : undefined}
          // Visible glyph stays compact so the indent rhythm holds,
          // but a transparent before:-inset-1 pseudo expands the hit
          // target to ~28×32 — clears WCAG 2.5.8 (24×24 minimum).
          className={cn(
            "text-forest-500 hover:text-forest-800 relative inline-flex h-6 w-1 flex-none items-center justify-center text-base leading-none px-2",
            "before:absolute before:-inset-1 before:content-['']",
            !hasChildren && "invisible",
          )}
          onClick={() => onToggle(node.id)}
          tabIndex={hasChildren ? 0 : -1}
        >
          {isOpen ? "▾" : "▸"}
        </button>
        <button
          type="button"
          onClick={() => {
            // Outline pick = intent-to-edit → open Inspect (`?w=1`).
            void focus(node.id, topicId, { write: true });
            if (hasChildren && !isOpen) {
              onToggle(node.id);
            }
          }}
          // Warm the node cache during hover so the editor pane has
          // data by the time the click lands — kills the
          // loading-state flash for first visits.
          onPointerEnter={() => prefetchNode(node.id)}
          onFocus={() => prefetchNode(node.id)}
          className="min-w-0 flex-1 truncate py-1 text-left"
          title={node.title}
        >
          {node.title || "Untitled"}
        </button>
      </div>
    </div>
  );
}
