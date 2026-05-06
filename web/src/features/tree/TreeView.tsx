/**
 * TreeView — single-topic deep-dive canvas with drag-to-reparent.
 *
 * Same sigma + graphology stack as ForestView, but scoped to one topic
 * so we can spend the canvas on showing the hierarchy in detail:
 *
 *   - Larger nodes + larger labels — readable at default zoom without
 *     squinting.
 *   - No cross-topic edges; this view only ever shows one topic's tree
 *     backbone and same-topic link edges.
 *   - Drag-to-reparent: hold a node, drop it on another node in the
 *     same tree to make that the new parent. Cycles, self-drops, and
 *     drops on the topic root are rejected client-side; the server
 *     validates again on PATCH.
 *
 * If the user wants the workspace overview they switch to Forest mode.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import Graph from "graphology";
import Sigma from "sigma";

import { useFocusNode } from "@/app/navigation";
import { useForestData } from "@/stores/forestData";
import { computeTreeLayout } from "@/features/forest/layout";
import { ApiError } from "@/lib/api";
import type { NodeId, NodeType, TopicId } from "@/lib/types";

interface Props {
  topicId: TopicId;
  focusedNodeId: NodeId;
}

const TREE_NODE_W = 260;
const TREE_NODE_H = 130;

const NODE_SIZE_DEFAULT = 14;
const NODE_SIZE_FOCUSED = 22;

const COLOR_FOREST_900 = "#152019";
const COLOR_FOREST_300 = "#b8c8be";
const COLOR_ACCENT = "#d47a5d";
const COLOR_ACCENT_DEEP = "#a85c3f";
const COLOR_LABEL = "#283128";

const TYPE_COLOR: Record<NodeType, string> = {
  concept: "#7b9082",
  fact: "#a8b3a0",
  source: "#c1ad7c",
  example: "#d4a574",
  question: "#b8a36d",
  task: "#7e9ba8",
  misc: "#9d9b91",
};

export function TreeView({ topicId, focusedNodeId }: Props) {
  const detail = useForestData((s) => s.topicDetails[topicId]);
  const fetchTopic = useForestData((s) => s.fetchTopic);
  const patchNode = useForestData((s) => s.patchNode);
  const focus = useFocusNode();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<Sigma | null>(null);

  // Drag state lives in refs so we can read it from sigma's reducer
  // and event handlers without forcing the sigma effect to re-run on
  // every drag tick. The reducer reads the ref each frame.
  const dragRef = useRef<{ node: NodeId | null; hover: NodeId | null }>({
    node: null,
    hover: null,
  });
  // Original layout positions, indexed by node id. Restored on cancel.
  const layoutPosRef = useRef(new Map<NodeId, { x: number; y: number }>());
  // Parent pointers derived from the tree layout, used for client-side
  // cycle prevention and to compute "self or descendant" guards.
  const parentByChildRef = useRef(new Map<NodeId, NodeId>());
  // Topic root id; we never let the root be picked up as a draggable.
  const rootIdRef = useRef<NodeId | null>(null);

  useEffect(() => {
    if (!detail) void fetchTopic(topicId).catch(() => {});
  }, [topicId, detail, fetchTopic]);

  const graph = useMemo<Graph | null>(() => {
    if (!detail) return null;
    const g = new Graph({ multi: false, type: "directed", allowSelfLoops: false });
    const layout = computeTreeLayout({
      nodes: detail.nodes.map((n) => ({ id: n.id, parent: n.parent, title: n.title })),
      rootId: detail.root_node_id,
      collapsed: [],
      nodeWidth: TREE_NODE_W,
      nodeHeight: TREE_NODE_H,
    });
    const summaryById = new Map(detail.nodes.map((n) => [n.id, n]));

    layoutPosRef.current = new Map();
    parentByChildRef.current = new Map();
    rootIdRef.current = detail.root_node_id;

    for (const n of layout.nodes) {
      const summary = summaryById.get(n.id);
      const focused = n.id === focusedNodeId;
      const type = summary?.type ?? "misc";
      // Sigma's y axis points up; tree y points down. Flip.
      const sx = n.x;
      const sy = -n.y;
      g.addNode(n.id, {
        x: sx,
        y: sy,
        size: focused ? NODE_SIZE_FOCUSED : NODE_SIZE_DEFAULT,
        label: summary?.title || n.title || "Untitled",
        color: focused ? COLOR_FOREST_900 : TYPE_COLOR[type],
        nodeType: type,
      });
      layoutPosRef.current.set(n.id, { x: sx, y: sy });
      if (n.parent) parentByChildRef.current.set(n.id, n.parent);
    }
    for (const e of layout.edges) {
      g.addEdgeWithKey(`tree:${e.source}->${e.target}`, e.source, e.target, {
        type: "line",
        size: 1.6,
        color: COLOR_FOREST_300,
      });
    }
    const local = new Set(detail.nodes.map((n) => n.id));
    const seen = new Set<string>();
    for (const summary of detail.nodes) {
      for (const dst of summary.links) {
        if (!local.has(dst)) continue;
        const key = summary.id < dst ? `${summary.id}|${dst}` : `${dst}|${summary.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        g.addEdgeWithKey(`link:${key}`, summary.id, dst, {
          type: "line",
          size: 1.8,
          color: COLOR_ACCENT,
        });
      }
    }
    return g;
  }, [detail, focusedNodeId]);

  // Walk up the parent chain to determine whether `target` sits inside
  // `dragged`'s subtree (which would create a cycle on reparent).
  const isInSubtree = useCallback((dragged: NodeId, target: NodeId): boolean => {
    const parents = parentByChildRef.current;
    let cursor: NodeId | undefined = target;
    const visited = new Set<NodeId>();
    while (cursor) {
      if (cursor === dragged) return true;
      if (visited.has(cursor)) return false;
      visited.add(cursor);
      cursor = parents.get(cursor);
    }
    return false;
  }, []);

  const isValidDrop = useCallback(
    (dragged: NodeId, target: NodeId): boolean => {
      if (dragged === target) return false;
      if (target === rootIdRef.current) {
        // Reparenting *to* the root is fine. The root cannot itself be
        // dragged but it is a legal drop target.
        return true;
      }
      if (isInSubtree(dragged, target)) return false;
      // Already-parent guard — pointless move that triggers a needless
      // server round trip.
      if (parentByChildRef.current.get(dragged) === target) return false;
      return true;
    },
    [isInSubtree],
  );

  useEffect(() => {
    if (!containerRef.current || !graph) return;
    if (sigmaRef.current) {
      sigmaRef.current.kill();
      sigmaRef.current = null;
    }
    const s = new Sigma(graph, containerRef.current, {
      renderLabels: true,
      labelSize: 14,
      labelWeight: "500",
      labelFont: "system-ui, sans-serif",
      labelColor: { color: COLOR_LABEL },
      labelDensity: 1.5,
      labelGridCellSize: 60,
      labelRenderedSizeThreshold: 0,
      defaultEdgeColor: COLOR_FOREST_300,
      defaultNodeColor: COLOR_FOREST_300,
      minCameraRatio: 0.2,
      maxCameraRatio: 5,
      // Per-frame style transform — reads dragRef so the visual matches
      // the live drag state without forcing sigma to be recreated.
      nodeReducer: (id, attrs) => {
        const out = { ...attrs };
        const { node: dragged, hover } = dragRef.current;
        if (id === dragged) {
          out.color = COLOR_ACCENT;
          out.size = (attrs.size as number) * 1.25;
          out.zIndex = 100;
        } else if (
          dragged &&
          hover === id &&
          dragged !== id &&
          isValidDrop(dragged, id)
        ) {
          out.color = COLOR_ACCENT_DEEP;
          out.size = (attrs.size as number) * 1.2;
        }
        return out;
      },
    });

    s.on("clickNode", ({ node }) => {
      // Suppressed when a drag was just released on this node — sigma
      // emits clickNode after upNode without a drag-distance threshold.
      // Cheap guard: skip when we just finished a drag.
      if (dragRef.current.node) return;
      void focus(node as NodeId, topicId);
    });

    s.on("downNode", ({ node, event }) => {
      // Topic root is the only node that can't be moved.
      if (node === rootIdRef.current) return;
      dragRef.current.node = node as NodeId;
      // Suppress sigma's pan handling so the canvas doesn't slide while
      // we drag the node around.
      event.preventSigmaDefault();
      event.original.preventDefault();
      event.original.stopPropagation();
      s.refresh();
    });

    s.on("enterNode", ({ node }) => {
      if (!dragRef.current.node) return;
      dragRef.current.hover = node as NodeId;
      s.refresh();
    });
    s.on("leaveNode", () => {
      if (!dragRef.current.node) return;
      dragRef.current.hover = null;
      s.refresh();
    });

    const mouseCaptor = s.getMouseCaptor();
    const onMove = (e: { x: number; y: number; preventSigmaDefault: () => void }) => {
      const dragged = dragRef.current.node;
      if (!dragged) return;
      const pos = s.viewportToGraph({ x: e.x, y: e.y });
      graph.setNodeAttribute(dragged, "x", pos.x);
      graph.setNodeAttribute(dragged, "y", pos.y);
      e.preventSigmaDefault();
    };
    const onUp = () => {
      const dragged = dragRef.current.node;
      if (!dragged) return;
      const target = dragRef.current.hover;
      const valid = target ? isValidDrop(dragged, target) : false;
      // Always restore the dragged node to its layout slot — even on a
      // valid drop, we want the immediate snap-back so the camera doesn't
      // jump. The store re-fetch then re-renders with the new position.
      const original = layoutPosRef.current.get(dragged);
      if (original) {
        graph.setNodeAttribute(dragged, "x", original.x);
        graph.setNodeAttribute(dragged, "y", original.y);
      }
      dragRef.current.node = null;
      dragRef.current.hover = null;
      s.refresh();
      if (valid && target) {
        void patchNode(dragged, { parent: target })
          .then(() => fetchTopic(topicId).catch(() => {}))
          .catch((err) => {
            // Server-side rejection — surface to the console; the UI
            // already snapped back.
            const msg =
              err instanceof ApiError
                ? `${err.code}: ${err.message}`
                : err instanceof Error
                  ? err.message
                  : String(err);
            console.warn("reparent rejected:", msg);
          });
      }
    };
    mouseCaptor.on("mousemovebody", onMove);
    mouseCaptor.on("mouseup", onUp);

    sigmaRef.current = s;
    return () => {
      s.kill();
      sigmaRef.current = null;
    };
  }, [graph, topicId, focus, patchNode, fetchTopic, isValidDrop]);

  if (!detail) {
    return (
      <div className="text-forest-400 flex h-full items-center justify-center text-sm">
        Loading…
      </div>
    );
  }
  if (graph && graph.order === 0) {
    return (
      <div className="text-forest-400 flex h-full items-center justify-center text-sm">
        Empty topic.
      </div>
    );
  }

  return <div ref={containerRef} className="bg-sand-50 h-full w-full" />;
}
