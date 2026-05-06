/**
 * TreeView — single-topic deep-dive canvas.
 *
 * Same sigma + graphology stack as ForestView, but scoped to one topic
 * so we can spend the canvas on showing the hierarchy in detail:
 *
 *   - Larger nodes + larger labels — readable at default zoom without
 *     squinting.
 *   - No cross-topic curves; the only edges are this topic's tree
 *     backbone and any same-topic link edges.
 *   - Camera centres on the focused node on mount so the user lands
 *     right where they came from in the editor.
 *
 * If the user wants to see how this topic sits relative to the rest of
 * the workspace they switch to Forest mode; this view deliberately
 * stays inside one topic's bounds.
 */

import { useEffect, useMemo, useRef } from "react";
import Graph from "graphology";
import Sigma from "sigma";

import { useFocusNode } from "@/app/navigation";
import { useForestData } from "@/stores/forestData";
import { computeTreeLayout } from "@/features/forest/layout";
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
  const focus = useFocusNode();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<Sigma | null>(null);

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
    for (const n of layout.nodes) {
      const summary = summaryById.get(n.id);
      const focused = n.id === focusedNodeId;
      const type = summary?.type ?? "misc";
      g.addNode(n.id, {
        x: n.x,
        // Sigma's y axis points up; tree y points down. Flip.
        y: -n.y,
        size: focused ? NODE_SIZE_FOCUSED : NODE_SIZE_DEFAULT,
        label: summary?.title || n.title || "Untitled",
        color: focused ? COLOR_FOREST_900 : TYPE_COLOR[type],
        nodeType: type,
      });
    }
    for (const e of layout.edges) {
      g.addEdgeWithKey(`tree:${e.source}->${e.target}`, e.source, e.target, {
        type: "line",
        size: 1.6,
        color: COLOR_FOREST_300,
      });
    }
    // Same-topic link edges as straight accent lines. Cross-topic links
    // are deliberately not shown here — that's Forest's job.
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

  useEffect(() => {
    if (!containerRef.current || !graph) return;
    if (sigmaRef.current) {
      sigmaRef.current.kill();
      sigmaRef.current = null;
    }
    const s = new Sigma(graph, containerRef.current, {
      renderLabels: true,
      // Bigger label than Forest — single topic means we can afford the
      // density; readability is the whole point of this mode.
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
    });

    s.on("clickNode", ({ node }) => {
      void focus(node as NodeId, topicId);
    });
    sigmaRef.current = s;

    return () => {
      s.kill();
      sigmaRef.current = null;
    };
  }, [graph, topicId, focus]);

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
