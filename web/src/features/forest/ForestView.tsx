/**
 * ForestView — workspace-level "many trees" canvas.
 *
 * One sigma scene that contains every topic in the workspace at once:
 *
 *   - Each topic is laid out as a hierarchical tree (d3-hierarchy) and
 *     translated horizontally so trees stand side by side with a gap.
 *   - Tree backbone edges (parent → child) sit thin and grey within
 *     each tree.
 *   - Link edges (`node.links`) are drawn between nodes regardless of
 *     which topic they live in. Same-topic links stay short and
 *     straight; cross-topic links are rendered as curves (via
 *     `@sigma/edge-curve`) so the long arc between trees is readable
 *     without colliding with intermediate nodes.
 *   - The currently focused node is highlighted darker + larger so the
 *     user always knows where they are coming from.
 *   - Each tree gets a floating topic-name label anchored to the tree's
 *     top-centre; positions are re-projected from graph space into
 *     viewport space on every camera update.
 *
 * Data: this view depends on having every topic's `TopicDetail`. We
 * trigger `fetchTopics` once and `fetchTopic` for any topic missing
 * details. Re-renders are cheap because graph construction only runs
 * when the underlying topicDetails / focus change.
 *
 * Lifecycle: the sigma instance is created once per assembled graph and
 * killed in cleanup. A minor compromise — we rebuild the graph and
 * remount sigma whenever any topic's nodes change — but at our scale
 * (hundreds of nodes per workspace, not thousands) the cost is invisible
 * and the code stays simple.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import EdgeCurveProgram from "@sigma/edge-curve";
import Graph from "graphology";
import Sigma from "sigma";

import { useFocusNode } from "@/app/navigation";
import { useForestData } from "@/stores/forestData";
import type { NodeId, NodeType, TopicDetail, TopicId } from "@/lib/types";

import { computeTreeLayout } from "./layout";

interface Props {
  focusedTopicId: TopicId;
  focusedNodeId: NodeId;
}

const TREE_NODE_W = 220;
const TREE_NODE_H = 110;

// Horizontal padding between adjacent trees, in graph units.
const TREE_GAP = 360;

const NODE_SIZE_DEFAULT = 8;
const NODE_SIZE_FOCUSED = 16;

// Palette — sigma renders to canvas/webgl so we hard-code rather than
// reading CSS variables. Mirrors `globals.css` `forest-*` / `accent`
// tokens.
const COLOR_FOREST_900 = "#152019";
const COLOR_FOREST_700 = "#39513f";
const COLOR_FOREST_300 = "#b8c8be";
const COLOR_ACCENT = "#d47a5d";
const COLOR_ACCENT_DEEP = "#a85c3f";
const COLOR_LABEL = "#3e4b41";

const TYPE_COLOR: Record<NodeType, string> = {
  concept: "#7b9082",
  fact: "#a8b3a0",
  source: "#c1ad7c",
  example: "#d4a574",
  question: "#b8a36d",
  task: "#7e9ba8",
  misc: "#9d9b91",
};

interface TopicAnchor {
  topicId: TopicId;
  title: string;
  // Graph-space coordinates of the tree's top-centre.
  graphX: number;
  graphY: number;
}

export function ForestView({ focusedTopicId, focusedNodeId }: Props) {
  const topics = useForestData((s) => s.topics);
  const topicDetails = useForestData((s) => s.topicDetails);
  const fetchTopics = useForestData((s) => s.fetchTopics);
  const fetchTopic = useForestData((s) => s.fetchTopic);
  const focus = useFocusNode();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<Sigma | null>(null);

  // Step 1: kick off summary fetch.
  useEffect(() => {
    void fetchTopics().catch(() => {});
  }, [fetchTopics]);

  // Step 2: ensure each known topic has a TopicDetail. Fires once per
  // newly-seen topic; idempotent because the store guards in-flight
  // requests via `loading.topicDetail`.
  useEffect(() => {
    for (const id of Object.keys(topics) as TopicId[]) {
      if (!topicDetails[id]) {
        void fetchTopic(id).catch(() => {});
      }
    }
  }, [topics, topicDetails, fetchTopic]);

  // Step 3: assemble the unified graph + per-tree anchors.
  const { graph, anchors, hasNoData } = useMemo(() => {
    const ready: TopicDetail[] = (Object.keys(topics) as TopicId[])
      .sort()
      .map((id) => topicDetails[id])
      .filter((d): d is TopicDetail => Boolean(d));

    if (ready.length === 0) {
      return {
        graph: null as Graph | null,
        anchors: [] as TopicAnchor[],
        hasNoData: Object.keys(topics).length === 0,
      };
    }

    const g = new Graph({ multi: false, type: "directed", allowSelfLoops: false });
    const anchorList: TopicAnchor[] = [];

    // Lay out each tree at origin and accumulate horizontal offset so
    // trees don't overlap.
    let cursorX = 0;
    for (const detail of ready) {
      const layout = computeTreeLayout({
        nodes: detail.nodes.map((n) => ({ id: n.id, parent: n.parent, title: n.title })),
        rootId: detail.root_node_id,
        collapsed: [],
        nodeWidth: TREE_NODE_W,
        nodeHeight: TREE_NODE_H,
      });
      if (layout.nodes.length === 0) continue;

      // The tree layout's x can be negative (root centred at 0). Shift
      // so this tree's leftmost point sits at `cursorX`.
      const offsetX = cursorX - layout.bounds.minX;
      const summaryById = new Map(detail.nodes.map((n) => [n.id, n]));

      for (const n of layout.nodes) {
        const summary = summaryById.get(n.id);
        const focused = n.id === focusedNodeId;
        const type = summary?.type ?? "misc";
        g.addNode(n.id, {
          // Sigma's y axis points up; tree y points down. Flip.
          x: n.x + offsetX,
          y: -n.y,
          size: focused ? NODE_SIZE_FOCUSED : NODE_SIZE_DEFAULT,
          label: summary?.title || n.title || "Untitled",
          color: focused ? COLOR_FOREST_900 : TYPE_COLOR[type],
          // Read by event handlers; not rendered.
          topicId: detail.id,
          nodeType: type,
        });
      }

      for (const e of layout.edges) {
        g.addEdgeWithKey(`tree:${e.source}->${e.target}`, e.source, e.target, {
          type: "line",
          size: 1.4,
          color: COLOR_FOREST_300,
        });
      }

      anchorList.push({
        topicId: detail.id,
        title: detail.title,
        // Centre of the tree's horizontal extent, plus a touch above
        // the root for visual breathing room.
        graphX: offsetX + (layout.bounds.minX + layout.bounds.maxX) / 2,
        graphY: -(layout.bounds.minY) + TREE_NODE_H * 0.6,
      });

      cursorX += (layout.bounds.maxX - layout.bounds.minX) + TREE_GAP;
    }

    // Pass 2: link edges. We need every node to be in the graph first
    // so we know which links land same-topic vs cross-topic. Walk the
    // already-known set of nodes (anything in `g`) — links to nodes
    // outside that set are silently dropped (their topic hasn't loaded
    // yet; the next fetchTopic re-renders).
    const seen = new Set<string>();
    for (const detail of ready) {
      for (const summary of detail.nodes) {
        if (!g.hasNode(summary.id)) continue;
        for (const dst of summary.links) {
          if (!g.hasNode(dst)) continue;
          const key = summary.id < dst ? `${summary.id}|${dst}` : `${dst}|${summary.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const sameTopic =
            (g.getNodeAttribute(summary.id, "topicId") as TopicId) ===
            (g.getNodeAttribute(dst, "topicId") as TopicId);
          if (sameTopic) {
            g.addEdgeWithKey(`link:${key}`, summary.id, dst, {
              type: "line",
              size: 1.6,
              color: COLOR_ACCENT,
            });
          } else {
            // Curved edge for cross-topic. Sigma's curve program reads
            // `type: "curve"` and the global `curvature` setting, so we
            // can keep the data flat.
            g.addEdgeWithKey(`xlink:${key}`, summary.id, dst, {
              type: "curve",
              size: 1.8,
              color: COLOR_ACCENT_DEEP,
            });
          }
        }
      }
    }

    return { graph: g, anchors: anchorList, hasNoData: false };
  }, [topics, topicDetails, focusedNodeId]);

  // Topic-anchor labels rendered as HTML on top of the canvas. We
  // recompute viewport positions on every camera update because the
  // canvas pans/zooms the underlying graph coords.
  const [labelPositions, setLabelPositions] = useState<
    { topicId: TopicId; title: string; left: number; top: number }[]
  >([]);
  const projectLabels = useCallback(
    (s: Sigma) => {
      setLabelPositions(
        anchors.map((a) => {
          const v = s.graphToViewport({ x: a.graphX, y: a.graphY });
          return { topicId: a.topicId, title: a.title, left: v.x, top: v.y };
        }),
      );
    },
    [anchors],
  );

  // Mount/remount sigma whenever the assembled graph changes. The
  // sigma instance is single-use — `kill()` releases its WebGL
  // resources, then we make a fresh one.
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
      defaultNodeColor: COLOR_FOREST_700,
      minCameraRatio: 0.05,
      maxCameraRatio: 4,
      // Curved edges are the unlock for cross-topic links — without
      // this they'd cut straight through the trees in between.
      edgeProgramClasses: {
        curve: EdgeCurveProgram,
      },
    });

    s.on("clickNode", ({ node }) => {
      const topicId = graph.getNodeAttribute(node, "topicId") as TopicId;
      void focus(node as NodeId, topicId);
    });
    s.on("afterRender", () => projectLabels(s));
    s.getCamera().on("updated", () => projectLabels(s));

    sigmaRef.current = s;

    // Initial centre on the focused node so opening Forest mode lands
    // the user at where they came from.
    if (graph.hasNode(focusedNodeId)) {
      const x = graph.getNodeAttribute(focusedNodeId, "x") as number;
      const y = graph.getNodeAttribute(focusedNodeId, "y") as number;
      s.getCamera().animate(
        { x: ratioToCamera(s, x, "x"), y: ratioToCamera(s, y, "y"), ratio: 1 },
        { duration: 0 },
      );
    }
    projectLabels(s);

    return () => {
      s.kill();
      sigmaRef.current = null;
    };
  }, [graph, focusedNodeId, focus, projectLabels]);

  if (hasNoData) {
    return (
      <div className="text-forest-400 flex h-full items-center justify-center text-sm">
        No topics yet.
      </div>
    );
  }
  if (!graph) {
    return (
      <div className="text-forest-400 flex h-full items-center justify-center text-sm">
        Loading…
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        className="bg-sand-50 absolute inset-0"
        // Sigma sets its own cursor on node hover; we keep grab here for
        // empty-canvas drags.
        style={{ cursor: "grab" }}
      />
      {/* Topic-name labels overlaid in HTML so we get crisp text + native
          accessibility instead of canvas-rasterised typography. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {labelPositions.map((p) => (
          <div
            key={p.topicId}
            className={
              "absolute -translate-x-1/2 -translate-y-full whitespace-nowrap " +
              (p.topicId === focusedTopicId
                ? "text-forest-900 font-medium"
                : "text-forest-500")
            }
            style={{ left: p.left, top: p.top }}
          >
            <span className="bg-sand-50/80 rounded-md px-2 py-0.5 text-xs backdrop-blur-sm">
              {p.title}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Convert graph-space coordinates into the camera state expected by
 * sigma's `Camera.animate`. Sigma's camera uses its own normalized
 * coordinate system; calling `viewportToFramedGraph` round-trips
 * through the sigma graphics pipeline so we don't have to recreate
 * the projection math by hand.
 */
function ratioToCamera(s: Sigma, value: number, axis: "x" | "y"): number {
  const v = s.graphToViewport(axis === "x" ? { x: value, y: 0 } : { x: 0, y: value });
  const f = s.viewportToFramedGraph(v);
  return f[axis];
}
