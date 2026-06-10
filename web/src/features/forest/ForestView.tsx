/**
 * ForestView — workspace-wide knowledge graph in the spirit of
 * Quartz's graph view.
 *
 * Reference: https://github.com/jackyzha0/quartz/blob/v4/quartz/components/scripts/graph.inline.ts
 *
 * Design:
 *   - One unified graph of every node across every topic.
 *   - Layout via d3-force (manyBody + center + link + collide). No
 *     orbit seeding; topics emerge as visual clusters because their
 *     nodes are densely connected within and sparsely across.
 *   - Node radius = 4 + sqrt(degree). Hubs read bigger, leaves smaller.
 *   - Labels hidden by default; only the hovered node and its direct
 *     neighbours light up + show titles. Everything else dims to 0.15
 *     alpha. Same affordance as the Quartz graph.
 *   - Same-topic links straight, cross-topic links curved.
 *   - Click navigates to the node.
 *   - Topic labels float above each cluster's centroid (post-settle)
 *     for orientation; click navigates to that topic's root.
 *
 * The component owns lifecycle wiring only; the moving parts live in
 * sibling modules:
 *   graphBuild.ts     data → settled graphology graph (d3-force)
 *   camera.ts         framedGraph conversions, fit, target resolution
 *   palette.ts        canvas colors read from tokens.css
 *   drawLabel.ts      hover-capsule label renderer
 *   useHoverDim.ts    hover fade progress + neighbour dim set
 *   useCameraAnchor.ts  keep focus centered through sidebar resize
 *
 * Lifecycle: graph rebuilds are gated on `forestLayoutKey` (structure
 * only — node set, tree edges, links) with a 150ms settle window, so
 * hydration bursts and title edits don't tear sigma down. Rebuilds
 * warm-start d3-force from `lastLayoutPositions` and carry the zoom
 * ratio over; the sigma instance is still single-use per rebuild.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import EdgeCurveProgram from "@sigma/edge-curve";
import Sigma from "sigma";

import { cn } from "@/lib/cn";
import { useFocusNode } from "@/app/navigation";
import { useForestData } from "@/stores/forestData";
import { useWorkspaceUI } from "@/stores/workspaceUI";
import type { NodeId, TopicId } from "@/lib/types";

import { buildForestGraph, forestLayoutKey } from "./graphBuild";
import {
  animateCameraToPoint,
  fitCameraToGraph,
  getForestCameraMode,
  getGraphNodePosition,
  resolveCameraTarget,
  setCameraToPoint,
  type GraphPoint,
} from "./camera";
import { makeDrawNodeLabel } from "./drawLabel";
import { palette, withAlpha } from "./palette";
import { useCameraAnchor } from "./useCameraAnchor";
import { useHoverDim } from "./useHoverDim";

interface Props {
  focusedTopicId: TopicId;
  focusedNodeId: NodeId;
}

// Hover dim alpha for non-neighbour nodes / edges.
const DIM_ALPHA = 0.3;
const HOVER_SCALE = 0.16;

// Layout-continuity cache: node positions from the last completed
// layout, fed back into buildForestGraph as warm-start seeds. Module
// level on purpose so it survives view switches (tree → forest → tree
// keeps the constellation in place). Purely derived data — stale or
// missing entries only mean a colder start, never wrong rendering.
const lastLayoutPositions = new Map<NodeId, GraphPoint>();

export function ForestView({ focusedTopicId, focusedNodeId }: Props) {
  const topics = useForestData((s) => s.topics);
  const topicDetails = useForestData((s) => s.topicDetails);
  const detailLoading = useForestData((s) => s.loading.topicDetail);
  const fetchTopics = useForestData((s) => s.fetchTopics);
  const fetchTopic = useForestData((s) => s.fetchTopic);
  const forestCameraIntent = useWorkspaceUI((s) => s.forestCameraIntent);
  const consumeForestCameraIntent = useWorkspaceUI((s) => s.consumeForestCameraIntent);
  const sidebarOpen = useWorkspaceUI((s) => s.sidebarOpen);
  const focus = useFocusNode();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  // Zoom carried across rebuilds *within* this mount — a structural
  // rebuild (node added/deleted) shouldn't reset how far the user has
  // zoomed. Across mounts (view switches) the ref resets and we re-fit.
  const prevRatioRef = useRef<number | null>(null);

  // Sigma init takes a real bite of main-thread time (d3-force 300 ticks
  // + canvas allocation). Outer NodePage wrapper animation finishes
  // before sigma even paints, so the entrance is invisible. We gate
  // ForestView's own opacity+scale transition on `sigmaReady`, flipped
  // to true one frame after sigma is constructed — guaranteeing the
  // "settle in" lands on actual rendered content.
  const [sigmaReady, setSigmaReady] = useState(false);

  useEffect(() => {
    void fetchTopics().catch(() => {});
  }, [fetchTopics]);

  useEffect(() => {
    for (const id of Object.keys(topics) as TopicId[]) {
      if (!topicDetails[id] && !detailLoading[id]) {
        void fetchTopic(id).catch(() => {});
      }
    }
  }, [topics, topicDetails, detailLoading, fetchTopic]);

  // Build + lay out the graph. Gated on the *structural* layout key,
  // not store object identity — hydration churn and per-keystroke
  // summary syncs share the same key, so they never trigger a relayout
  // or sigma teardown. A 150ms settle window coalesces hydration
  // bursts (N topic details resolving → one rebuild instead of N).
  // The window only applies once a graph exists; the first real build
  // settles immediately so initial paint isn't delayed.
  const layoutKey = forestLayoutKey(topics, topicDetails);
  const [settledKey, setSettledKey] = useState(layoutKey);

  const { graph, anchors, neighbors, hasNoData } = useMemo(
    () => buildForestGraph(topics, topicDetails, lastLayoutPositions),
    // Deliberately narrowed: settledKey is a pure function of
    // (topics, topicDetails) — when it changes, this render's snapshots
    // are exactly the ones that produced it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settledKey],
  );

  useEffect(() => {
    if (layoutKey === settledKey) return;
    if (!graph) {
      setSettledKey(layoutKey);
      return;
    }
    const t = window.setTimeout(() => setSettledKey(layoutKey), 150);
    return () => window.clearTimeout(t);
  }, [layoutKey, settledKey, graph]);

  // Capture settled positions for the next warm start. Replace
  // wholesale so deleted nodes drop out of the cache.
  useEffect(() => {
    if (!graph) return;
    lastLayoutPositions.clear();
    graph.forEachNode((id, attrs) =>
      lastLayoutPositions.set(id as NodeId, { x: attrs.x as number, y: attrs.y as number }),
    );
  }, [graph]);

  // Title / type edits don't change the layout key; sync them into the
  // live graph in place so labels and colors stay fresh without a
  // relayout.
  useEffect(() => {
    if (!graph) return;
    let dirty = false;
    for (const detail of Object.values(topicDetails)) {
      for (const n of detail.nodes) {
        if (!graph.hasNode(n.id)) continue;
        const label = n.title || "Untitled";
        if (graph.getNodeAttribute(n.id, "label") !== label) {
          graph.setNodeAttribute(n.id, "label", label);
          dirty = true;
        }
        const color = palette().types[n.type];
        if (graph.getNodeAttribute(n.id, "color") !== color) {
          graph.setNodeAttribute(n.id, "color", color);
          dirty = true;
        }
      }
    }
    if (dirty) sigmaRef.current?.refresh();
  }, [graph, topicDetails]);

  const cameraAnchorRef = useCameraAnchor(sigmaRef, sidebarOpen);
  const {
    hoverNode,
    setHover,
    progressRef: hoverProgressRef,
    resolveDimSet,
  } = useHoverDim(sigmaRef, neighbors);

  const labelsLayerRef = useRef<HTMLDivElement | null>(null);
  const labelNodeRefs = useRef(new Map<TopicId, HTMLDivElement>());

  const focusedNodeIdRef = useRef(focusedNodeId);
  const focusedTopicIdRef = useRef(focusedTopicId);
  useEffect(() => {
    focusedNodeIdRef.current = focusedNodeId;
    const s = sigmaRef.current;
    if (!s || !graph) {
      focusedTopicIdRef.current = focusedTopicId;
      return;
    }

    focusedTopicIdRef.current = focusedTopicId;
    const cameraMode = getForestCameraMode({
      focusedNodeId,
      focusedTopicId,
      intent: forestCameraIntent,
    });
    if (!cameraMode) return;

    const target = resolveCameraTarget({
      focusedNodeId,
      focusedTopicId,
      graph,
      cameraMode,
      topicDetails,
    });
    if (!target) return;

    // Repaint first so the focused node's ink color updates even when
    // the camera doesn't move.
    s.refresh();
    // Skip the tween when the camera is already anchored on this exact
    // target — clickNode animates immediately and the URL change lands
    // here right after; a second animate to the same point restarts the
    // easing mid-flight, which reads as a hitch.
    const anchor = cameraAnchorRef.current;
    const alreadyAnchored =
      anchor !== null &&
      Math.abs(anchor.x - target.x) < 1e-9 &&
      Math.abs(anchor.y - target.y) < 1e-9;
    if (!alreadyAnchored) {
      animateCameraToPoint(s, target, { duration: 400 });
    }
    cameraAnchorRef.current = target;
    consumeForestCameraIntent(focusedNodeId, focusedTopicId);
  }, [
    cameraAnchorRef,
    consumeForestCameraIntent,
    focusedNodeId,
    focusedTopicId,
    forestCameraIntent,
    graph,
    topicDetails,
  ]);

  useEffect(() => {
    // Reset visibility on every graph rebuild so the next reveal
    // triggers a fresh transition (false → true) rather than being
    // batched away.
    setSigmaReady(false);
    if (!containerRef.current || !graph) return;
    if (sigmaRef.current) {
      prevRatioRef.current = sigmaRef.current.getCamera().ratio;
      sigmaRef.current.kill();
      sigmaRef.current = null;
    }

    const drawLabel = makeDrawNodeLabel(() => hoverProgressRef.current);

    const s = new Sigma(graph, containerRef.current, {
      // Labels off by default — only the hovered node + its neighbours
      // get `forceLabel: true` via the reducer.
      renderLabels: true,
      labelSize: 12,
      labelFont: "system-ui, sans-serif",
      labelColor: { attribute: "labelColor", color: palette().label },
      labelRenderedSizeThreshold: Infinity,
      defaultEdgeColor: palette().dim,
      defaultNodeColor: palette().dim,
      minCameraRatio: 0.05,
      maxCameraRatio: 4,
      hideLabelsOnMove: true,
      hideEdgesOnMove: false,
      edgeProgramClasses: { curve: EdgeCurveProgram },

      defaultDrawNodeHover: drawLabel,
      defaultDrawNodeLabel: drawLabel,

      nodeReducer: (id, attrs) => {
        const out: typeof attrs & { forceLabel?: boolean; isHoveredNode?: boolean } = {
          ...attrs,
        };

        if (id === focusedNodeIdRef.current) {
          out.color = palette().ink;
        }

        const hoverBoost = hoverProgressRef.current;

        if (hoverBoost > 0) {
          // Live hover set while the pointer is on a node; sticky
          // snapshot while the fade-out plays. useHoverDim arbitrates.
          const { hovered, neighbors: neighborSet } = resolveDimSet();

          const isHovered = id === hovered;
          const isNeighbor = neighborSet.has(id as NodeId);

          if (isHovered || isNeighbor) {
            out.forceLabel = true;
            out.isHoveredNode = isHovered; // read by the drawLabel renderer
            if (isHovered) {
              out.size = (attrs.size as number) * (1 + HOVER_SCALE * hoverBoost);
            }
          } else {
            const currentAlpha = 1 - (1 - DIM_ALPHA) * hoverBoost;
            out.color = withAlpha(attrs.color as string, currentAlpha);
            out.label = "";
          }
        }
        return out;
      },
      edgeReducer: (id, attrs) => {
        const out: typeof attrs = { ...attrs };
        const hoverBoost = hoverProgressRef.current;

        if (hoverBoost > 0 && graph.hasEdge(id)) {
          const { hovered } = resolveDimSet();

          if (hovered) {
            const [src, tgt] = graph.extremities(id);
            if (src !== hovered && tgt !== hovered) {
              const currentAlpha = 1 - (1 - DIM_ALPHA) * hoverBoost;
              out.color = withAlpha(attrs.color as string, currentAlpha);
            }
          }
        }
        return out;
      },
    });

    const projectOverlays = () => {
      for (const a of anchors) {
        const label = labelNodeRefs.current.get(a.topicId);
        if (!label) continue;
        const v = s.graphToViewport({ x: a.centerX, y: a.topY });
        label.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) translate(-50%, -100%)`;
      }
    };

    s.refresh();

    s.on("clickNode", ({ node }) => {
      const topicId = graph.getNodeAttribute(node, "topicId") as TopicId;
      const x = graph.getNodeAttribute(node, "x") as number;
      const y = graph.getNodeAttribute(node, "y") as number;

      void focus(node as NodeId, topicId);
      animateCameraToPoint(s, { x, y }, { duration: 400 });
      cameraAnchorRef.current = { x, y };
    });
    s.on("enterNode", ({ node }) => setHover(node as NodeId));
    s.on("leaveNode", () => setHover(null));
    s.getCamera().on("updated", projectOverlays);
    s.on("afterRender", projectOverlays);

    sigmaRef.current = s;
    if (prevRatioRef.current !== null) {
      // Rebuild within this mount: restore the user's zoom instead of
      // re-fitting. Warm-started layouts keep coordinates roughly
      // stable, so with the ratio preserved and the camera re-centred
      // on the focus below, a rebuild reads as "nothing moved".
      s.getCamera().setState({ ratio: prevRatioRef.current });
    } else {
      fitCameraToGraph(s, graph);
    }
    // Default anchor = the graph point that the fit just centred —
    // i.e. the current viewport centre in graph coords.
    {
      const { width, height } = s.getDimensions();
      if (width > 0 && height > 0) {
        cameraAnchorRef.current = s.viewportToGraph({ x: width / 2, y: height / 2 });
      }
    }

    if (focusedNodeIdRef.current && graph.hasNode(focusedNodeIdRef.current)) {
      const target =
        resolveCameraTarget({
          focusedNodeId: focusedNodeIdRef.current,
          focusedTopicId: focusedTopicIdRef.current,
          graph,
          // Graph rebuilds can be caused by background topic-detail hydration
          // before the route focus changes. Preserve the current node then;
          // route-driven topic changes are handled by the focus effect above.
          cameraMode: "node",
          topicDetails,
        }) ?? getGraphNodePosition(graph, focusedNodeIdRef.current);
      if (!target) {
        projectOverlays();
        return () => {
          prevRatioRef.current = s.getCamera().ratio;
          s.kill();
          sigmaRef.current = null;
        };
      }
      setCameraToPoint(s, target);
      cameraAnchorRef.current = target;
    }

    projectOverlays();

    // Reveal one frame after sigma is constructed so the entrance
    // transition starts the moment the first real frame paints, not
    // before. Without this the outer NodePage wrapper finishes
    // animating while the canvas is still blank.
    const revealRafId = requestAnimationFrame(() => setSigmaReady(true));

    return () => {
      cancelAnimationFrame(revealRafId);
      prevRatioRef.current = s.getCamera().ratio;
      s.kill();
      sigmaRef.current = null;
    };
  }, [graph, focus, anchors, neighbors, setHover, resolveDimSet, hoverProgressRef, cameraAnchorRef]);

  const srSummary = useMemo(() => {
    if (!graph) return "";
    const topicCount = anchors.length;
    const totalNodes = graph.order;
    const topicTitles = anchors.map((a) => `${a.title} (${a.nodeCount})`).join(", ");
    return `Forest map of the workspace. ${topicCount} topic${topicCount === 1 ? "" : "s"}, ${totalNodes} node${totalNodes === 1 ? "" : "s"} total. Topics: ${topicTitles}.`;
  }, [anchors, graph]);

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
    <div
      className={cn(
        "bg-forest-50 relative h-full w-full overflow-hidden",
        // Matches tree-card-in's curve + the NodePage wrapper; combined
        // with sigmaReady gating below, the visible "settle in" starts
        // exactly when sigma's first canvas frame paints.
        "transition-[opacity,transform] duration-[320ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]",
        sigmaReady ? "opacity-100 scale-100" : "opacity-0 scale-[0.97]",
      )}
      role="region"
      aria-label="Forest map of the workspace"
    >
      <div
        ref={containerRef}
        className="absolute inset-0"
        role="application"
        aria-label={srSummary || "Forest canvas"}
        style={{ cursor: hoverNode ? "pointer" : "grab", backgroundColor: "transparent" }}
      />
      <div className="sr-only">
        <p>{srSummary}</p>
        {anchors.map((a) => (
          <p key={a.topicId}>
            {a.title}: {a.nodeCount} node{a.nodeCount === 1 ? "" : "s"}.
          </p>
        ))}
      </div>
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
                  if (detail) {
                    void focus(detail.root_node_id, detail.id, {
                      forestCameraMode: "topic-root",
                    });
                  }
                }}
                className={
                  "pointer-events-auto border-forest-200 bg-forest-50/90 hover:bg-sand-100 hover:border-forest-300 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-serif backdrop-blur-md shadow-glass transition-colors " +
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
