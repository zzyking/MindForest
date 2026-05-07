/**
 * ForestView — workspace as a galaxy of topic clusters.
 *
 * Each topic becomes its own constellation: nodes laid out via the
 * d3-hierarchy tree pipeline, then translated so the cluster centre
 * sits on a circular orbit around the workspace origin. With N topics
 * the orbit ring carries them at evenly-spaced angles; tree shapes
 * stay legible inside each cluster while the surrounding empty space
 * lets cross-topic links sweep across as long arcs.
 *
 *   - Cluster centre = orbit point (cos·θ, sin·θ) · WORKSPACE_RADIUS.
 *   - Tree-internal positions kept (root at cluster centre, children
 *     splaying out the local tree's natural extent).
 *   - Backbone tree edges thin grey within each cluster.
 *   - Same-topic link edges stay straight (close together so curving
 *     adds nothing); cross-topic link edges curve via @sigma/edge-curve
 *     so they don't slice through a neighbour cluster.
 *   - The currently focused node renders darker + larger; clicking any
 *     other node navigates focus.
 *   - Each cluster carries a floating topic-name label anchored to
 *     its centre; clicking the label navigates to that topic's root.
 *
 * Data: this view needs every topic's `TopicDetail`. We trigger
 * `fetchTopics` once and `fetchTopic` for any topic missing details.
 *
 * Lifecycle: the sigma instance rebuilds whenever the assembled graph
 * changes. At workspace scale (hundreds of nodes) the cost is invisible
 * and the code stays simple.
 */

import { useEffect, useMemo, useRef } from "react";
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

const TREE_NODE_W = 160;
const TREE_NODE_H = 90;

// Galaxy layout. Each topic centre sits on a circle around the
// workspace origin. Radius scales with topic count so adjacent
// clusters don't bump into each other; SINGLE_RADIUS handles the
// degenerate one-topic case so the lone cluster doesn't sit on top of
// the camera origin awkwardly.
const ORBIT_GAP_PER_CLUSTER = 700;
const ORBIT_MIN_RADIUS = 900;
const SINGLE_RADIUS = 0;
const NODE_SCALE = 0.55;

const NODE_SIZE_DEFAULT = 6;
const NODE_SIZE_FOCUSED = 14;

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
  const detailLoading = useForestData((s) => s.loading.topicDetail);
  const fetchTopics = useForestData((s) => s.fetchTopics);
  const fetchTopic = useForestData((s) => s.fetchTopic);
  const focus = useFocusNode();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<Sigma | null>(null);

  // Step 1: kick off summary fetch.
  useEffect(() => {
    void fetchTopics().catch(() => {});
  }, [fetchTopics]);

  // Step 2: ensure each known topic has a TopicDetail. The effect runs
  // each time the loading map mutates (i.e. a fetch starts or
  // resolves), so checking `detailLoading[id]` here keeps us from
  // double-firing while a request is already in flight — the store
  // itself doesn't dedupe.
  useEffect(() => {
    for (const id of Object.keys(topics) as TopicId[]) {
      if (!topicDetails[id] && !detailLoading[id]) {
        void fetchTopic(id).catch(() => {});
      }
    }
  }, [topics, topicDetails, detailLoading, fetchTopic]);

  // Step 3: assemble the unified graph + per-tree anchors.
  const { graph, anchors, hasNoData } = useMemo(() => {
    const buildStart = performance.now();
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

    // Position each topic's cluster centre on a circular orbit around
    // (0, 0). Single-topic case sits at origin so the camera doesn't
    // need an off-centre starting frame.
    const N = ready.length;
    const orbitRadius =
      N === 1 ? SINGLE_RADIUS : Math.max(ORBIT_MIN_RADIUS, ORBIT_GAP_PER_CLUSTER * N / (2 * Math.PI));

    for (let i = 0; i < ready.length; i++) {
      const detail = ready[i]!;
      const layout = computeTreeLayout({
        nodes: detail.nodes.map((n) => ({ id: n.id, parent: n.parent, title: n.title })),
        rootId: detail.root_node_id,
        collapsed: [],
        nodeWidth: TREE_NODE_W,
        nodeHeight: TREE_NODE_H,
      });
      if (layout.nodes.length === 0) continue;

      // Orbit angle: start at the top (-π/2) and walk clockwise so the
      // first topic feels "anchored" up there.
      const theta = N === 1 ? 0 : (2 * Math.PI * i) / N - Math.PI / 2;
      const cx = Math.cos(theta) * orbitRadius;
      const cy = Math.sin(theta) * orbitRadius;

      // Shift the tree so its (root-aligned) centre lands at (cx, cy).
      // The tree layout puts the root at x=0 by construction; y is
      // depth-driven so the root sits at the top. We shift in y so the
      // bounding box centres on the cluster point.
      const treeCY = (layout.bounds.minY + layout.bounds.maxY) / 2;
      const summaryById = new Map(detail.nodes.map((n) => [n.id, n]));

      for (const n of layout.nodes) {
        const summary = summaryById.get(n.id);
        const focused = n.id === focusedNodeId;
        const type = summary?.type ?? "misc";
        g.addNode(n.id, {
          x: cx + n.x * NODE_SCALE,
          // Flip tree y (grows down) into sigma y (grows up); centre on
          // cluster.
          y: cy - (n.y - treeCY) * NODE_SCALE,
          size: focused ? NODE_SIZE_FOCUSED : NODE_SIZE_DEFAULT,
          label: summary?.title || n.title || "Untitled",
          color: focused ? COLOR_FOREST_900 : TYPE_COLOR[type],
          topicId: detail.id,
          nodeType: type,
        });
      }

      for (const e of layout.edges) {
        g.addEdgeWithKey(`tree:${e.source}->${e.target}`, e.source, e.target, {
          type: "line",
          size: 1.2,
          color: COLOR_FOREST_300,
        });
      }

      // Topic label anchored at the cluster centre, lifted slightly
      // above so it doesn't collide with the cluster's root node.
      const treeHeight = (layout.bounds.maxY - layout.bounds.minY) * NODE_SCALE;
      anchorList.push({
        topicId: detail.id,
        title: detail.title,
        graphX: cx,
        graphY: cy + treeHeight / 2 + TREE_NODE_H * NODE_SCALE,
      });
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

    const totalNodes = g.order;
    const totalEdges = g.size;
    const buildMs = (performance.now() - buildStart).toFixed(1);
    console.info(
      `[forest] graph built in ${buildMs}ms · ${ready.length} topics · ${totalNodes} nodes · ${totalEdges} edges`,
    );
    return { graph: g, anchors: anchorList, hasNoData: false };
  }, [topics, topicDetails, focusedNodeId]);

  // Topic-anchor labels rendered as HTML on top of the canvas. We
  // mutate `transform` on each label DOM node directly via refs every
  // time the camera moves — going through React state would re-render
  // the whole label list at frame rate during pan/zoom, which thrashes
  // the main thread at scale.
  const labelsLayerRef = useRef<HTMLDivElement | null>(null);
  const labelNodeRefs = useRef(new Map<TopicId, HTMLDivElement>());

  // Mount/remount sigma whenever the assembled graph changes. The
  // sigma instance is single-use — `kill()` releases its WebGL
  // resources, then we make a fresh one.
  useEffect(() => {
    if (!containerRef.current || !graph) return;
    if (sigmaRef.current) {
      sigmaRef.current.kill();
      sigmaRef.current = null;
    }
    const mountStart = performance.now();
    const s = new Sigma(graph, containerRef.current, {
      renderLabels: true,
      labelSize: 12,
      labelFont: "system-ui, sans-serif",
      labelColor: { color: COLOR_LABEL },
      // Density / grid tuned for crowded canvases — at 5k nodes the
      // default 1 / 80 paints far more text than the eye can use.
      labelDensity: 0.5,
      labelGridCellSize: 120,
      // Skip labels for nodes too small to read at the current zoom —
      // lets sigma cull aggressively when the user zooms out to see the
      // whole forest.
      labelRenderedSizeThreshold: 6,
      defaultEdgeColor: COLOR_FOREST_300,
      defaultNodeColor: COLOR_FOREST_700,
      minCameraRatio: 0.05,
      maxCameraRatio: 4,
      // Hide labels and edges during drags / zooms — sigma redraws on
      // every frame, and edge geometry + label layout dominate cost.
      // Snap them back when the camera settles.
      hideLabelsOnMove: true,
      hideEdgesOnMove: true,
      // Curved edges are the unlock for cross-topic links — without
      // this they'd cut straight through the trees in between.
      edgeProgramClasses: {
        curve: EdgeCurveProgram,
      },
    });

    const projectLabels = () => {
      for (const a of anchors) {
        const el = labelNodeRefs.current.get(a.topicId);
        if (!el) continue;
        const v = s.graphToViewport({ x: a.graphX, y: a.graphY });
        // translate3d so the browser keeps these layers on the GPU.
        el.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) translate(-50%, -100%)`;
      }
    };

    s.on("clickNode", ({ node }) => {
      const topicId = graph.getNodeAttribute(node, "topicId") as TopicId;
      void focus(node as NodeId, topicId);
    });
    s.getCamera().on("updated", projectLabels);

    sigmaRef.current = s;
    console.info(`[forest] sigma mounted in ${(performance.now() - mountStart).toFixed(1)}ms`);

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
    // Initial position pass once labels are in the DOM. The labels are
    // rendered statically below; their transforms get nudged here.
    projectLabels();

    return () => {
      s.kill();
      sigmaRef.current = null;
    };
  }, [graph, focusedNodeId, focus, anchors]);

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
          accessibility instead of canvas-rasterised typography. Each
          label sits absolute at (0,0); its transform is updated directly
          (no React re-render) on every camera tick. */}
      <div
        ref={labelsLayerRef}
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        {anchors.map((a) => {
          const focused = a.topicId === focusedTopicId;
          const detail = topicDetails[a.topicId];
          return (
            <div
              key={a.topicId}
              ref={(el) => {
                if (el) labelNodeRefs.current.set(a.topicId, el);
                else labelNodeRefs.current.delete(a.topicId);
              }}
              className="absolute left-0 top-0 whitespace-nowrap will-change-transform"
            >
              <button
                type="button"
                onClick={() => {
                  if (detail) void focus(detail.root_node_id, detail.id);
                }}
                className={
                  "pointer-events-auto border bg-sand-50/85 hover:bg-sand-100 rounded-full px-3 py-1 font-serif text-sm backdrop-blur-sm transition-colors " +
                  (focused
                    ? "text-forest-900 border-accent"
                    : "text-forest-700 border-forest-200")
                }
              >
                {a.title}
              </button>
            </div>
          );
        })}
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
