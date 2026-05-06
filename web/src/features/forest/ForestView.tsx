/**
 * ForestView — the unified canvas for one topic's hierarchy + cross-refs.
 *
 * Replaces the old TreeView (SVG hierarchy) and GraphView (React Flow
 * horizontal tree). Instead of two modes that show roughly the same
 * thing twice, we render one sigma canvas with:
 *
 *   - Tree backbone edges (parent → child), light grey, solid
 *   - Same-topic link edges (`node.links`), accent, thinner
 *   - Cross-topic stub edges (P4-Forest-3, follow-up commit)
 *
 * Layout is computed eagerly via `computeTreeLayout` (the same d3-hierarchy
 * pipeline the old TreeView used) and pinned into the graphology graph
 * as `x`/`y` attributes. We don't run a force simulation by default —
 * deterministic positions keep hit-testing and animations stable. A
 * future P4 task can opt into ForceAtlas2 when we add a "focus
 * neighbourhood" mode for highly cross-linked topics.
 *
 * Sigma lifecycle:
 *   - The `Sigma` instance is created once per (topic, focus) tuple and
 *     `kill()`'d on cleanup. We rebuild rather than diff because the
 *     graph structure changes whenever the topic does, and graphology's
 *     mutate-in-place API is more bug-prone than recreate-from-scratch
 *     given how rarely this fires.
 *   - Click → focus the node via the router. Sigma's camera handles
 *     pan/zoom out of the box; we don't bind any wheel/pointer handlers.
 */

import { useEffect, useMemo, useRef } from "react";
import Graph from "graphology";
import Sigma from "sigma";

import { useFocusNode } from "@/app/navigation";
import { useForestData } from "@/stores/forestData";
import { computeTreeLayout } from "./layout";
import type { NodeId, NodeType, TopicId } from "@/lib/types";

interface Props {
  topicId: TopicId;
  focusedNodeId: NodeId;
}

const TREE_NODE_W = 220;
const TREE_NODE_H = 120;

// Node visual sizes (sigma units — these are abstract; the camera scales).
const NODE_SIZE_DEFAULT = 8;
const NODE_SIZE_FOCUSED = 14;

// CSS color literals. Mirrors `globals.css` tokens; sigma renders to
// canvas/webgl so we can't use CSS variables directly.
const COLOR_FOREST_800 = "#1f2e25";
const COLOR_FOREST_300 = "#b8c8be";
const COLOR_FOREST_500 = "#5b7a64";
const COLOR_ACCENT = "#d47a5d";
const COLOR_LABEL = "#3e4b41";

const TYPE_COLOR: Record<NodeType, string> = {
  concept: "#7b9082",
  fact: "#a8b3a0",
  source: "#a3837a",
  example: "#d4a574",
  question: "#b8a36d",
  task: "#7e9ba8",
  misc: "#9d9b91",
};

export function ForestView({ topicId, focusedNodeId }: Props) {
  const detail = useForestData((s) => s.topicDetails[topicId]);
  const fetchTopic = useForestData((s) => s.fetchTopic);
  const focus = useFocusNode();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<Sigma | null>(null);

  useEffect(() => {
    if (!detail) void fetchTopic(topicId).catch(() => {});
  }, [topicId, detail, fetchTopic]);

  // Rebuild graph whenever the topic's nodes or focus change. This is
  // the source of truth for what sigma renders; the effect below picks
  // it up.
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
    for (const n of layout.nodes) {
      const summary = summaryById.get(n.id);
      const focused = n.id === focusedNodeId;
      g.addNode(n.id, {
        // Sigma's y axis points up; tree layout's y points down. Flip.
        x: n.x,
        y: -n.y,
        size: focused ? NODE_SIZE_FOCUSED : NODE_SIZE_DEFAULT,
        label: summary?.title || n.title || "Untitled",
        color: focused ? COLOR_FOREST_800 : TYPE_COLOR[summary?.type ?? "misc"],
        // Custom payload — we read this back in event handlers.
        nodeType: summary?.type ?? "misc",
      });
    }
    // Tree backbone edges. Keyed by parent→child for stability.
    for (const e of layout.edges) {
      g.addEdgeWithKey(`tree:${e.source}->${e.target}`, e.source, e.target, {
        type: "line",
        size: 1.2,
        color: COLOR_FOREST_300,
      });
    }
    // Same-topic link edges (dashed-ish — sigma's default line program
    // doesn't natively dash, so we use accent + thinner stroke to
    // distinguish from the backbone). Cross-topic links land in
    // P4-Forest-3.
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
          size: 1,
          color: COLOR_ACCENT,
        });
      }
    }
    return g;
  }, [detail, focusedNodeId]);

  // Mount / remount sigma when the graph changes. We `kill()` and
  // recreate rather than mutate the existing graph in place — easier to
  // reason about, and graph rebuilds are cheap at our scale.
  useEffect(() => {
    if (!containerRef.current || !graph) return;
    if (sigmaRef.current) {
      sigmaRef.current.kill();
      sigmaRef.current = null;
    }
    const s = new Sigma(graph, containerRef.current, {
      renderLabels: true,
      labelSize: 12,
      labelFont: "system-ui, sans-serif",
      labelColor: { color: COLOR_LABEL },
      labelDensity: 1,
      labelGridCellSize: 80,
      defaultEdgeColor: COLOR_FOREST_300,
      defaultNodeColor: COLOR_FOREST_500,
      minCameraRatio: 0.2,
      maxCameraRatio: 5,
    });
    s.on("clickNode", ({ node }) => {
      void focus(node, topicId);
    });
    sigmaRef.current = s;
    // Centre on focus on mount.
    if (graph.hasNode(focusedNodeId)) {
      const cam = s.getCamera();
      const attrs = graph.getNodeAttributes(focusedNodeId) as { x: number; y: number };
      const view = s.graphToViewport({ x: attrs.x, y: attrs.y });
      cam.animate(s.viewportToFramedGraph(view), { duration: 0 });
    }
    return () => {
      s.kill();
      sigmaRef.current = null;
    };
  }, [graph, topicId, focusedNodeId, focus]);

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
