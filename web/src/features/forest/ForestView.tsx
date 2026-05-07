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
const ORBIT_GAP_PER_CLUSTER = 380;
const ORBIT_MIN_RADIUS = 380;
const SINGLE_RADIUS = 0;
const NODE_SCALE = 0.5;

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
  /** Cluster centre in graph space — used both for the floating
   *  topic-name label and the radial halo overlay. */
  centerX: number;
  centerY: number;
  /** Top of the cluster's bounding box (label sits above this). */
  topY: number;
  /** Furthest distance from centre to any node, used to size the halo. */
  radius: number;
  nodeCount: number;
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

    // Position each topic's cluster centre. With one topic, sit at
    // origin (the camera fits to a single cluster cleanly). With two,
    // place them on a horizontal line so the canvas reads as
    // "side-by-side galaxies" rather than two trees stacked
    // vertically. Three or more lay out on a circular orbit, starting
    // from the top. Sigma's y axis points up, so a "top" cluster
    // wants positive y (theta = +π/2), not the visual-down -π/2.
    const N = ready.length;
    const initialAngle = N === 2 ? Math.PI : Math.PI / 2;
    const orbitRadius =
      N === 1
        ? SINGLE_RADIUS
        : Math.max(ORBIT_MIN_RADIUS, (ORBIT_GAP_PER_CLUSTER * N) / (2 * Math.PI));

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

      const theta = N === 1 ? 0 : (2 * Math.PI * i) / N + initialAngle;
      const cx = Math.cos(theta) * orbitRadius;
      const cy = Math.sin(theta) * orbitRadius;

      // Shift the tree so its bounding-box centre lands on (cx, cy).
      const treeCY = (layout.bounds.minY + layout.bounds.maxY) / 2;
      const summaryById = new Map(detail.nodes.map((n) => [n.id, n]));

      let maxR = 0;
      let minSY = Infinity;
      for (const n of layout.nodes) {
        const summary = summaryById.get(n.id);
        const focused = n.id === focusedNodeId;
        const type = summary?.type ?? "misc";
        const sx = cx + n.x * NODE_SCALE;
        // Flip tree y (grows down) into sigma y (grows up); centre on
        // cluster.
        const sy = cy - (n.y - treeCY) * NODE_SCALE;
        g.addNode(n.id, {
          x: sx,
          y: sy,
          size: focused ? NODE_SIZE_FOCUSED : NODE_SIZE_DEFAULT,
          label: summary?.title || n.title || "Untitled",
          color: focused ? COLOR_FOREST_900 : TYPE_COLOR[type],
          topicId: detail.id,
          nodeType: type,
        });
        const dx = sx - cx;
        const dy = sy - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r > maxR) maxR = r;
        if (sy > minSY === false) minSY = Math.min(minSY, sy);
        else if (sy < minSY) minSY = sy;
      }

      for (const e of layout.edges) {
        g.addEdgeWithKey(`tree:${e.source}->${e.target}`, e.source, e.target, {
          type: "line",
          size: 1.2,
          color: COLOR_FOREST_300,
        });
      }

      // Topic label anchored above the cluster's top edge with a touch
      // of breathing room. Halo radius is the cluster's furthest node
      // distance plus padding so edges aren't clipped inside. Sigma's
      // y axis is up, so the cluster's *top* in graph space is the
      // largest y value — `cy + maxR + …`.
      const haloPadding = TREE_NODE_H * NODE_SCALE * 0.7;
      anchorList.push({
        topicId: detail.id,
        title: detail.title,
        centerX: cx,
        centerY: cy,
        topY: cy + maxR + haloPadding,
        radius: maxR + haloPadding,
        nodeCount: detail.nodes.length,
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

  // HTML overlay refs. We mutate `transform` directly on these per
  // camera update — going through React state would re-render the
  // whole layer at frame rate, which thrashes the main thread.
  const labelsLayerRef = useRef<HTMLDivElement | null>(null);
  const labelNodeRefs = useRef(new Map<TopicId, HTMLDivElement>());
  const haloNodeRefs = useRef(new Map<TopicId, HTMLDivElement>());

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
      labelDensity: 0.5,
      labelGridCellSize: 120,
      labelRenderedSizeThreshold: 6,
      defaultEdgeColor: COLOR_FOREST_300,
      defaultNodeColor: COLOR_FOREST_700,
      minCameraRatio: 0.05,
      maxCameraRatio: 4,
      hideLabelsOnMove: true,
      hideEdgesOnMove: true,
      edgeProgramClasses: {
        curve: EdgeCurveProgram,
      },
    });

    const projectOverlays = () => {
      for (const a of anchors) {
        // Halo: position at cluster centre, scale to cluster radius.
        const halo = haloNodeRefs.current.get(a.topicId);
        if (halo) {
          const c = s.graphToViewport({ x: a.centerX, y: a.centerY });
          // Sigma's graphToViewport reflects the camera's current
          // ratio, so a unit graph distance maps to a viewport distance
          // we can read by sampling a second point.
          const edge = s.graphToViewport({ x: a.centerX + a.radius, y: a.centerY });
          const r = Math.abs(edge.x - c.x);
          halo.style.transform = `translate3d(${c.x - r}px, ${c.y - r}px, 0)`;
          halo.style.width = `${r * 2}px`;
          halo.style.height = `${r * 2}px`;
        }
        // Label: position above the cluster's top edge.
        const label = labelNodeRefs.current.get(a.topicId);
        if (label) {
          const v = s.graphToViewport({ x: a.centerX, y: a.topY });
          label.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) translate(-50%, -100%)`;
        }
      }
    };

    s.on("clickNode", ({ node }) => {
      const topicId = graph.getNodeAttribute(node, "topicId") as TopicId;
      void focus(node as NodeId, topicId);
    });
    s.getCamera().on("updated", projectOverlays);
    s.on("afterRender", projectOverlays);

    sigmaRef.current = s;
    console.info(`[forest] sigma mounted in ${(performance.now() - mountStart).toFixed(1)}ms`);

    // Explicit fit-to-graph. Sigma's default auto-fit only roughly
    // frames the node bounding box; we want extra padding so clusters
    // (which extend slightly beyond their root nodes) and their halos
    // don't graze the viewport edges.
    fitCameraToGraph(s, graph);
    projectOverlays();

    return () => {
      s.kill();
      sigmaRef.current = null;
    };
  }, [graph, focus, anchors]);

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
    <div className="bg-noise relative h-full w-full overflow-hidden">
      {/* Atmosphere layer: a soft radial wash from the workspace centre
          gives the canvas depth so empty space between clusters reads
          as "outer dark" rather than blank paper. Stays under the
          sigma canvas via z-order. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(245,247,245,1) 0%, rgba(230,237,233,0.92) 55%, rgba(204,214,209,0.6) 100%)",
        }}
      />
      {/* Per-cluster halo: a translucent radial glow centred on each
          cluster, sized to the cluster's outermost node. Helps each
          topic read as "a place" instead of free-floating dots. */}
      <div className="pointer-events-none absolute inset-0">
        {anchors.map((a) => (
          <div
            key={a.topicId}
            ref={(el) => {
              if (el) haloNodeRefs.current.set(a.topicId, el);
              else haloNodeRefs.current.delete(a.topicId);
            }}
            aria-hidden
            className="absolute left-0 top-0 rounded-full will-change-transform"
            style={{
              background:
                a.topicId === focusedTopicId
                  ? "radial-gradient(circle, rgba(212,122,93,0.18) 0%, rgba(212,122,93,0.05) 60%, transparent 80%)"
                  : "radial-gradient(circle, rgba(85,124,104,0.16) 0%, rgba(85,124,104,0.04) 60%, transparent 80%)",
            }}
          />
        ))}
      </div>
      {/* Sigma canvas. Transparent bg so atmosphere + halos show
          through. */}
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{ cursor: "grab", backgroundColor: "transparent" }}
      />
      {/* Topic-name labels: floating pills above each cluster. Click
          navigates to that topic's root. */}
      <div ref={labelsLayerRef} className="pointer-events-none absolute inset-0">
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
                  "pointer-events-auto border-forest-200 bg-sand-50/90 hover:bg-sand-100 hover:border-forest-300 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-serif backdrop-blur-md shadow-glass transition-colors " +
                  (focused
                    ? "text-forest-900 border-accent ring-1 ring-accent/30"
                    : "text-forest-700")
                }
              >
                <span className="text-base leading-none">{a.title}</span>
                <span className="text-forest-400 text-[10px] uppercase tracking-[0.08em] tabular-nums">
                  {a.nodeCount}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Frame the camera so every node fits inside the viewport with a small
 * margin. Sigma's default fit is too tight for the galaxy view —
 * cluster halos extend past the node bounding box, and we want a bit
 * of "outer dark" visible so the metaphor reads.
 */
function fitCameraToGraph(s: Sigma, graph: Graph) {
  if (graph.order === 0) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  graph.forEachNode((_id, attrs) => {
    const x = attrs.x as number;
    const y = attrs.y as number;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const halfW = Math.max(1, (maxX - minX) / 2);
  const halfH = Math.max(1, (maxY - minY) / 2);
  // We want the bounds (with padding) to span the viewport. Sigma's
  // camera ratio is in normalized graph units; sample two graph points
  // through the projection to learn how many graph-units of width
  // currently equal the viewport's width, then scale ratio so the
  // bounds — padded — match.
  const container = s.getContainer();
  const vw = container.clientWidth || 1;
  const vh = container.clientHeight || 1;
  const padding = 1.25;
  // Sample current graph-units-per-pixel via two probes one pixel apart.
  const probeA = s.viewportToGraph({ x: 0, y: 0 });
  const probeB = s.viewportToGraph({ x: vw, y: 0 });
  const graphUnitsPerViewportWidth = Math.abs(probeB.x - probeA.x);
  // Desired width-in-graph-units so bounds fit with padding.
  const wantedWidth = halfW * 2 * padding;
  const wantedHeight = halfH * 2 * padding;
  // Pick ratio such that the larger of (wanted/vw, wanted/vh) drives
  // the framing. `ratio` in sigma is (graph-units-per-screen-unit) /
  // (current-units-per-screen-unit) — multiplying by the wanted/current
  // ratio scales accordingly.
  const cam = s.getCamera();
  const currentRatio = cam.ratio;
  const ratio =
    currentRatio *
    Math.max(
      wantedWidth / graphUnitsPerViewportWidth,
      (wantedHeight / graphUnitsPerViewportWidth) * (vw / vh),
    );
  const view = s.graphToViewport({ x: cx, y: cy });
  const framed = s.viewportToFramedGraph(view);
  cam.setState({ x: framed.x, y: framed.y, ratio, angle: 0 });
}

