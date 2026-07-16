/**
 * ForestView — the Morph Field (workspace-wide knowledge graph).
 *
 * Design:
 *   - One unified graph of every node across every topic.
 *   - Live d3-force via useSimLoop; sleeps when cool; reheats on structure.
 *   - L2 morph: user-owned μ (近↔远) drives camera dolly + soft materials
 *     (dual-zone hysteresis). Empty-field wheel nudges μ; bubble hover
 *     never morphs. Inspect freezes μ (snapshot/restore in NodePage).
 *   - Soft-body discs via drawNode; questions carry static hunger marks.
 *   - Labels: hover capsule + zoom fade. Tree edges straight; refs curved.
 *   - Click focuses; second click / double-click opens Inspect.
 *   - Topic labels float above clusters (live anchors).
 *
 * Lifecycle: ONE ForestLayout and ONE sigma per mount. Structure diffs
 * via forestLayoutKey + 150ms settle. Cross-mount continuity via
 * lastLayoutPositions.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import EdgeCurveProgram from "@sigma/edge-curve";
import Sigma from "sigma";

import { cn } from "@/lib/cn";
import { useFocusNode } from "@/app/navigation";
import { useForestData } from "@/stores/forestData";
import { useMorph } from "@/stores/morph";
import { useWorkspaceUI } from "@/stores/workspaceUI";
import type { NodeId, TopicId } from "@/lib/types";

import {
  computeTopicAnchorPoints,
  createForestLayout,
  forestLayoutKey,
  presettleForFit,
  syncForestStructure,
  type ForestLayout,
  type TopicAnchorInfo,
} from "./graphBuild";
import {
  animateCameraToPoint,
  fitCameraToGraph,
  getForestCameraMode,
  getGraphNodePosition,
  resolveCameraTarget,
  type GraphPoint,
} from "./camera";
import { dimSoftColor, softNodeColor, softNodeSize } from "./drawNode";
import { makeDrawNodeLabel } from "./drawLabel";
import { MorphSlider } from "./MorphSlider";
import { cameraRatioForMu, edgeStyleForMaterial } from "./morphMap";
import { wireNodeDrag } from "./nodeDrag";
import { palette, withAlpha } from "./palette";
import { useCameraAnchor } from "./useCameraAnchor";
import { useHoverDim } from "./useHoverDim";
import { useSimLoop } from "./useSimLoop";

/** Module-level sigma handle so Inspect can read the focused node's
 *  viewport origin without coupling NodePage into the sim stack. */
let liveSigma: Sigma | null = null;

/** Screen-space center of a graph node (viewport coords), or null. */
export function getFocusedNodeViewportPoint(nodeId: NodeId): { x: number; y: number } | null {
  const s = liveSigma;
  if (!s) return null;
  const graph = s.getGraph();
  if (!graph.hasNode(nodeId)) return null;
  const x = graph.getNodeAttribute(nodeId, "x") as number;
  const y = graph.getNodeAttribute(nodeId, "y") as number;
  try {
    return s.graphToViewport({ x, y });
  } catch {
    return null;
  }
}

interface Props {
  focusedTopicId: TopicId;
  focusedNodeId: NodeId;
  /** Inspect open — hide morph chrome; wheel must not morph. */
  inspectOpen?: boolean;
}

// Hover dim alpha for non-neighbour nodes / edges.
const DIM_ALPHA = 0.3;
const HOVER_SCALE = 0.16;

// Zoom-based label fade — continuous in camera ratio (lower = closer).
// Near morph shows more titles; far keeps overview clean.
const LABEL_FADE_OFFSET = 0.35;
const zoomLabelAlpha = (ratio: number) =>
  Math.min(1, Math.max(0, Math.log2(1 / ratio) - LABEL_FADE_OFFSET));

// Layout-continuity cache: node positions captured when the view
// unmounts, fed back as warm-start seeds on the next mount. Module
// level on purpose so it survives view switches (tree → forest → tree
// keeps the constellation in place). Purely derived data — stale or
// missing entries only mean a colder start, never wrong rendering.
const lastLayoutPositions = new Map<NodeId, GraphPoint>();

export function ForestView({ focusedTopicId, focusedNodeId, inspectOpen = false }: Props) {
  const topics = useForestData((s) => s.topics);
  const topicDetails = useForestData((s) => s.topicDetails);
  const detailLoading = useForestData((s) => s.loading.topicDetail);
  const detailErrors = useForestData((s) => s.errors.topicDetail);
  const fetchTopics = useForestData((s) => s.fetchTopics);
  const fetchTopic = useForestData((s) => s.fetchTopic);
  const createNode = useForestData((s) => s.createNode);
  const forestCameraIntent = useWorkspaceUI((s) => s.forestCameraIntent);
  const consumeForestCameraIntent = useWorkspaceUI((s) => s.consumeForestCameraIntent);
  const sidebarOpen = useWorkspaceUI((s) => s.sidebarOpen);
  const focus = useFocusNode();

  const mu = useMorph((s) => s.mu);
  const material = useMorph((s) => s.material);
  const fitRatio = useMorph((s) => s.fitRatio);
  const morphFrozen = useMorph((s) => s.frozen);
  const nudgeMu = useMorph((s) => s.nudgeMu);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const materialRef = useRef(material);
  materialRef.current = material;
  const hoverNodeRef = useRef<NodeId | null>(null);

  // The live layout — graph + simulation, one per mount.
  const layoutRef = useRef<ForestLayout | null>(null);
  // Cold-mount only: settled positions captured by presettleForFit, so
  // the sigma effect can frame + freeze bbox against the resting scale
  // (matching a warm switch-back) while nodes still bloom from the seed.
  // Consumed once, then nulled.
  const coldRestPositionsRef = useRef<Map<NodeId, GraphPoint> | null>(null);
  // Flipped once the layout has real structure; gates sigma creation.
  const [graphReady, setGraphReady] = useState(false);
  // React-rendered derivatives of the layout, replaced on each sync.
  const [anchors, setAnchors] = useState<TopicAnchorInfo[]>([]);
  const [neighbors, setNeighbors] = useState<Map<NodeId, Set<NodeId>>>(() => new Map());

  const { reheat, ensureRunning } = useSimLoop(layoutRef, sigmaRef);

  // Cursor feedback while dragging a node — React owns the cursor
  // style, so this must be state (a raw style mutation would be
  // clobbered by any re-render mid-drag).
  const [draggingNode, setDraggingNode] = useState(false);
  const [addingQuestion, setAddingQuestion] = useState(false);

  // Sigma init takes a real bite of main-thread time. The outer
  // NodePage wrapper animation finishes before sigma even paints, so
  // we gate ForestView's own opacity+scale transition on `sigmaReady`,
  // flipped one frame after sigma is constructed — guaranteeing the
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

  // Structure syncs are gated on the *structural* layout key, not
  // store object identity — hydration churn and per-keystroke summary
  // syncs share the same key, so they never touch the graph. A 150ms
  // settle window coalesces hydration bursts (N topic details
  // resolving → one diff instead of N). The window only applies once a
  // layout exists; the first real sync lands immediately so initial
  // paint isn't delayed.
  const layoutKey = forestLayoutKey(topics, topicDetails);
  const [settledKey, setSettledKey] = useState(layoutKey);

  useEffect(() => {
    if (layoutKey === settledKey) return;
    if (!layoutRef.current) {
      setSettledKey(layoutKey);
      return;
    }
    const t = window.setTimeout(() => setSettledKey(layoutKey), 150);
    return () => window.clearTimeout(t);
  }, [layoutKey, settledKey]);

  // Diff the store snapshot into the live layout, then decide how much
  // energy the change deserves.
  useEffect(() => {
    let layout = layoutRef.current;
    const isCreation = !layout;
    if (isCreation) {
      // Hold the FIRST build until every known topic has resolved
      // (detail or error). Building from a partial snapshot fits the
      // camera to one topic, and when the rest hydrate ~150ms later
      // the graph bbox multiplies — sigma renormalizes coordinates
      // against it and the view visibly jumps out and off-centre.
      // Errored topics count as resolved so one bad fetch can't hold
      // the view hostage; they're absent from the graph either way.
      const ids = Object.keys(topics) as TopicId[];
      const allResolved =
        ids.length > 0 && ids.every((id) => topicDetails[id] || detailErrors[id]);
      if (!allResolved) return;
    }
    if (!layout) layout = createForestLayout();
    const res = syncForestStructure(
      layout,
      topics,
      topicDetails,
      isCreation ? lastLayoutPositions : undefined,
    );
    if (!res.hasReadyData) return;
    layoutRef.current = layout;
    setAnchors(layout.anchors);
    setNeighbors(layout.neighbors);
    setGraphReady(true);
    if (isCreation) {
      if (res.warmFraction >= 0.95) {
        // Warm mount (view switch back): positions resume nearly settled
        // — a low simmer finishes whatever relaxing was cut off at
        // unmount without visibly rearranging anything. The fit runs
        // against these already-settled positions.
        reheat(0.1);
      } else {
        // Cold mount: pre-relax once to learn the resting scale and
        // stash those positions for the sigma effect's fit, so the cold
        // view frames the SETTLED forest at the same size a warm
        // switch-back would (the user's preferred size) instead of the
        // tighter seed. Nodes then bloom from the compact seed into that
        // pre-sized frame (0.6 won the crossing-harness sweep).
        coldRestPositionsRef.current = presettleForFit(layout);
        reheat(0.6);
      }
    } else if (res.added > 0 || res.removed > 0 || res.edgesChanged) {
      // Fold the newcomers in without blasting the settled majority.
      reheat(0.3);
    }
    // The closure's snapshots are exactly the ones that produced
    // settledKey — see the settle effect above. detailErrors is a real
    // dependency for the creation gate: a failed fetch doesn't change
    // the layout key (the topic stays "pending"), so the gate must
    // re-evaluate when an error lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledKey, detailErrors]);

  // Title / type edits don't change the layout key; sync them into the
  // live graph in place so labels and colors stay fresh without a
  // structure diff.
  useEffect(() => {
    const graph = layoutRef.current?.graph;
    if (!graph || !graphReady) return;
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
        if (graph.getNodeAttribute(n.id, "nodeType") !== n.type) {
          graph.setNodeAttribute(n.id, "nodeType", n.type);
          dirty = true;
        }
      }
    }
    if (dirty) sigmaRef.current?.refresh();
  }, [graphReady, topicDetails]);

  // Apply morph material → edge style; camera ratio from μ + fitRatio.
  useEffect(() => {
    const s = sigmaRef.current;
    const graph = layoutRef.current?.graph;
    if (!s || !graph || !graphReady) return;

    const es = edgeStyleForMaterial(material);
    graph.forEachEdge((edge, attrs) => {
      const kind = attrs.kind as string;
      const base =
        kind === "tree"
          ? palette().dim
          : kind === "link"
            ? palette().accent
            : palette().accentDeep;
      const alpha = kind === "tree" ? es.treeAlpha : es.linkAlpha;
      const size = kind === "tree" ? es.treeSize : es.linkSize;
      graph.setEdgeAttribute(edge, "color", withAlpha(base, alpha));
      graph.setEdgeAttribute(edge, "size", size);
    });

    if (fitRatio != null && !morphFrozen) {
      const cam = s.getCamera();
      const next = cameraRatioForMu(mu, fitRatio);
      const cur = cam.ratio;
      if (Math.abs(cur - next) > 0.001) {
        cam.setState({ ratio: next });
      }
    }
    s.refresh();
  }, [graphReady, material, mu, fitRatio, morphFrozen]);

  const cameraAnchorRef = useCameraAnchor(sigmaRef, sidebarOpen);
  const {
    hoverNode,
    setHover,
    progressRef: hoverProgressRef,
    resolveDimSet,
  } = useHoverDim(sigmaRef, neighbors);

  const labelNodeRefs = useRef(new Map<TopicId, HTMLDivElement>());

  // Callback refs so the (single-use) sigma effect never has to re-run
  // when a dependency's identity churns — setHover closes over the
  // per-sync neighbors map, and tearing sigma down for that would
  // throw away the whole "graph is alive" continuity.
  const focusRef = useRef(focus);
  const setHoverRef = useRef(setHover);
  const inspectOpenRef = useRef(inspectOpen);
  const morphFrozenRef = useRef(morphFrozen);
  useEffect(() => {
    focusRef.current = focus;
    setHoverRef.current = setHover;
  }, [focus, setHover]);
  useEffect(() => {
    inspectOpenRef.current = inspectOpen;
    morphFrozenRef.current = morphFrozen;
  }, [inspectOpen, morphFrozen]);

  // Empty-field wheel → μ (not over bubble / Inspect / chrome).
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !graphReady) return;
    let lastTs = 0;
    const onWheel = (e: WheelEvent) => {
      if (inspectOpenRef.current || morphFrozenRef.current) return;
      // Pointer over a node → content/no-op (never morph).
      if (hoverNodeRef.current) return;
      // Don't steal horizontal-ish trackpad pans.
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX) * 0.6) return;
      e.preventDefault();
      e.stopPropagation();
      // Throttle ~45Hz + ease via small steps.
      const now = performance.now();
      if (now - lastTs < 22) return;
      lastTs = now;
      // Positive deltaY = scroll down = farther (μ ↑).
      const raw = e.deltaY;
      const step = Math.sign(raw) * Math.min(0.055, Math.abs(raw) * 0.0012 + 0.012);
      nudgeMu(step);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [graphReady, nudgeMu]);

  const openQuestionCount = useMemo(() => {
    const detail = topicDetails[focusedTopicId];
    if (!detail) return 0;
    return detail.nodes.filter((n) => n.type === "question").length;
  }, [topicDetails, focusedTopicId]);

  const onAddChildQuestion = useCallback(async () => {
    if (addingQuestion || inspectOpen) return;
    const detail = topicDetails[focusedTopicId];
    if (!detail) return;
    const parent = detail.nodes.find((n) => n.id === focusedNodeId);
    if (!parent) return;
    setAddingQuestion(true);
    try {
      const child = await createNode({
        topic: focusedTopicId,
        parent: focusedNodeId,
        title: "Untitled question",
        content: "",
        node_type: "question",
      });
      await focus(child.id, child.topic, { write: true });
    } catch {
      // Store surfaces errors; keep field calm.
    } finally {
      setAddingQuestion(false);
    }
  }, [
    addingQuestion,
    inspectOpen,
    topicDetails,
    focusedTopicId,
    focusedNodeId,
    createNode,
    focus,
  ]);

  const focusedNodeIdRef = useRef(focusedNodeId);
  const focusedTopicIdRef = useRef(focusedTopicId);
  useEffect(() => {
    focusedNodeIdRef.current = focusedNodeId;
    const s = sigmaRef.current;
    const graph = layoutRef.current?.graph ?? null;
    if (!s || !graph || !graphReady) {
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
    graphReady,
    topicDetails,
  ]);

  // Sigma lifecycle — created once per mount, killed only at unmount.
  // Structure changes mutate the graph it's already rendering.
  useEffect(() => {
    if (!containerRef.current || !graphReady) return;
    const layout = layoutRef.current;
    if (!layout) return;
    const graph = layout.graph;

    const drawLabel = makeDrawNodeLabel(
      () => hoverProgressRef.current,
      // Reading the live ratio per draw (via sigmaRef — the instance
      // doesn't exist yet on this line) is what makes the fade
      // continuous through camera ratio changes from μ.
      () => {
        const live = sigmaRef.current;
        return live ? zoomLabelAlpha(live.getCamera().ratio) : 0;
      },
      () => materialRef.current,
    );

    const s = new Sigma(graph, containerRef.current, {
      // Every node carries forceLabel — visibility is decided per frame
      // inside drawLabel (hover ramp ∨ zoom fade), which costs one
      // early-returning call per node and avoids reducer re-runs on
      // camera moves.
      renderLabels: true,
      labelSize: 12,
      labelFont: "system-ui, sans-serif",
      labelColor: { attribute: "labelColor", color: palette().label },
      labelRenderedSizeThreshold: Infinity,
      defaultEdgeColor: palette().dim,
      defaultNodeColor: palette().dim,
      minCameraRatio: 0.05,
      maxCameraRatio: 4,
      // Morph owns wheel — disable sigma camera zoom so trackpad doesn't
      // fight μ. Pan (drag empty) still works via enableCameraPanning.
      enableCameraZooming: false,
      // Labels must stay visible *during* camera moves — the zoom fade
      // rides the animation; hiding the layer would turn it into a pop
      // at the end.
      hideLabelsOnMove: false,
      hideEdgesOnMove: false,
      edgeProgramClasses: { curve: EdgeCurveProgram },

      defaultDrawNodeHover: drawLabel,
      defaultDrawNodeLabel: drawLabel,

      nodeReducer: (id, attrs) => {
        const out: typeof attrs & { forceLabel?: boolean; isHoveredNode?: boolean } = {
          ...attrs,
        };

        // Every node's label is force-rendered; drawLabel applies the
        // continuous zoom/hover alpha (early-returns at 0). Hover dim
        // below still blanks labels on dimmed nodes.
        out.forceLabel = true;

        const nodeType = (attrs.nodeType as string | undefined) ?? undefined;
        const mat = materialRef.current;
        const baseSize = attrs.size as number;
        const baseColor =
          id === focusedNodeIdRef.current
            ? palette().ink
            : softNodeColor((attrs.color as string) || palette().dim, nodeType, mat);

        out.color = baseColor;
        out.size = softNodeSize(baseSize, nodeType, mat);
        out.nodeType = nodeType;

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
              out.size = (out.size as number) * (1 + HOVER_SCALE * hoverBoost);
            }
          } else {
            const currentAlpha = 1 - (1 - DIM_ALPHA) * hoverBoost;
            out.color = dimSoftColor(baseColor, currentAlpha);
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

    // Topic labels track their (drifting) clusters: positions are
    // recomputed from the live graph on every render/camera tick.
    const projectOverlays = () => {
      const points = computeTopicAnchorPoints(graph);
      for (const [topicId, el] of labelNodeRefs.current) {
        const p = points.get(topicId);
        if (!p) continue;
        const v = s.graphToViewport(p);
        el.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) translate(-50%, -100%)`;
      }
    };

    // Cold mount: temporarily move nodes to their pre-computed resting
    // positions so the frozen bbox + initial fit are sized for the
    // SETTLED forest (matching a warm switch-back — the size the user
    // prefers). Nodes snap back to the seed right after, and the live
    // bloom animates outward into this pre-sized frame. Synchronous, so
    // the relaxed positions never paint. Warm mounts skip this — their
    // current positions already are the settled ones.
    const coldRest = coldRestPositionsRef.current;
    coldRestPositionsRef.current = null;
    let seedSnapshot: Map<NodeId, GraphPoint> | null = null;
    if (coldRest) {
      seedSnapshot = new Map();
      graph.forEachNode((id, attrs) => {
        seedSnapshot!.set(id as NodeId, { x: attrs.x as number, y: attrs.y as number });
        const r = coldRest.get(id as NodeId);
        if (r) {
          graph.setNodeAttribute(id, "x", r.x);
          graph.setNodeAttribute(id, "y", r.y);
        }
      });
    }

    s.refresh();

    // Freeze coordinate normalization NOW, against the (settled, for a
    // cold mount) bbox. Sigma otherwise renormalizes against the live
    // bbox on every refresh — any later bbox growth (a new topic placed
    // beyond the current extent, an agent batch widening a cluster, a
    // node dragged outwards) would rescale the whole view as a visible
    // jump. Frozen bbox is only a coordinate-space reference; nodes
    // outside it render fine.
    s.setCustomBBox(s.getBBox());

    const drag = wireNodeDrag(s, layout, ensureRunning, setDraggingNode);

    s.on("clickNode", ({ node }) => {
      // A completed drag emits clickNode on release — don't navigate.
      if (drag.wasDragged()) return;
      const topicId = graph.getNodeAttribute(node, "topicId") as TopicId;
      const x = graph.getNodeAttribute(node, "x") as number;
      const y = graph.getNodeAttribute(node, "y") as number;
      const id = node as NodeId;
      // Second click on already-focused node → open Inspect.
      const openWrite = focusedNodeIdRef.current === id;

      void focusRef.current(id, topicId, openWrite ? { write: true } : undefined);
      animateCameraToPoint(s, { x, y }, { duration: 400 });
      cameraAnchorRef.current = { x, y };
    });
    s.on("doubleClickNode", (payload) => {
      // Prevent sigma's default double-click zoom when opening Inspect.
      payload.preventSigmaDefault();
      if (drag.wasDragged()) return;
      const node = payload.node;
      const topicId = graph.getNodeAttribute(node, "topicId") as TopicId;
      const x = graph.getNodeAttribute(node, "x") as number;
      const y = graph.getNodeAttribute(node, "y") as number;
      void focusRef.current(node as NodeId, topicId, { write: true });
      animateCameraToPoint(s, { x, y }, { duration: 400 });
      cameraAnchorRef.current = { x, y };
    });
    s.on("enterNode", ({ node }) => {
      hoverNodeRef.current = node as NodeId;
      setHoverRef.current(node as NodeId);
    });
    s.on("leaveNode", () => {
      hoverNodeRef.current = null;
      setHoverRef.current(null);
    });
    s.getCamera().on("updated", projectOverlays);
    s.on("afterRender", projectOverlays);

    sigmaRef.current = s;
    liveSigma = s;
    // Initial framing: fit the whole forest, centred on the focused
    // node when there is one. fitCameraToGraph measures half-extents
    // from the centre point, so "my node is centred" and "everything
    // is visible" hold simultaneously — no post-fit re-centring that
    // would push other clusters off-screen. On a cold mount the graph
    // currently holds the settled positions (swapped in above), so the
    // focus centre and extents are the resting ones.
    const focusId = focusedNodeIdRef.current;
    const mountTarget =
      focusId && graph.hasNode(focusId)
        ? (resolveCameraTarget({
            focusedNodeId: focusId,
            focusedTopicId: focusedTopicIdRef.current,
            graph,
            // Mount can happen before the route focus changes;
            // preserve the current node then — route-driven topic
            // changes are handled by the focus effect above.
            cameraMode: "node",
            topicDetails: useForestData.getState().topicDetails,
          }) ?? getGraphNodePosition(graph, focusId))
        : null;
    fitCameraToGraph(s, graph, mountTarget ? { center: mountTarget } : undefined);
    // Capture fit ratio as morph base, then apply cold-open μ dolly.
    const fitted = s.getCamera().ratio;
    useMorph.getState().setFitRatio(fitted);
    s.getCamera().setState({ ratio: cameraRatioForMu(useMorph.getState().mu, fitted) });
    if (mountTarget) {
      cameraAnchorRef.current = mountTarget;
    } else {
      // Anchor = the graph point the fit just centred.
      const { width, height } = s.getDimensions();
      if (width > 0 && height > 0) {
        cameraAnchorRef.current = s.viewportToGraph({ x: width / 2, y: height / 2 });
      }
    }

    // Snap nodes back to the compact seed; the camera frame + frozen
    // bbox are now sized for where they'll come to rest, and the live
    // simulation blooms outward into it.
    if (seedSnapshot) {
      for (const [id, p] of seedSnapshot) {
        graph.setNodeAttribute(id, "x", p.x);
        graph.setNodeAttribute(id, "y", p.y);
      }
      s.refresh();
    }

    projectOverlays();

    // Resume the tick loop if the simulation still has energy — a
    // StrictMode remount (or any future re-run) cancels the rAF in
    // useSimLoop's cleanup, and nothing else would restart it.
    ensureRunning();

    // Reveal one frame after sigma is constructed so the entrance
    // transition starts the moment the first real frame paints, not
    // before. Without this the outer NodePage wrapper finishes
    // animating while the canvas is still blank.
    const revealRafId = requestAnimationFrame(() => setSigmaReady(true));

    return () => {
      cancelAnimationFrame(revealRafId);
      drag.dispose();
      // Cross-mount continuity: persist where every node ended up.
      lastLayoutPositions.clear();
      for (const n of layout.simNodes) {
        lastLayoutPositions.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
      }
      s.kill();
      sigmaRef.current = null;
      if (liveSigma === s) liveSigma = null;
    };
    // Refs (callbacks routed through focusRef/setHoverRef) keep this
    // effect single-use; only graphReady's false→true flip triggers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphReady, resolveDimSet, hoverProgressRef, cameraAnchorRef, ensureRunning]);

  const srSummary = useMemo(() => {
    if (anchors.length === 0) return "";
    const totalNodes = anchors.reduce((s, a) => s + a.nodeCount, 0);
    const topicTitles = anchors.map((a) => `${a.title} (${a.nodeCount})`).join(", ");
    return `Forest map of the workspace. ${anchors.length} topic${anchors.length === 1 ? "" : "s"}, ${totalNodes} node${totalNodes === 1 ? "" : "s"} total. Topics: ${topicTitles}.`;
  }, [anchors]);

  if (Object.keys(topics).length === 0) {
    return (
      <div className="text-forest-400 flex h-full items-center justify-center text-sm">
        No topics yet.
      </div>
    );
  }
  if (!graphReady) {
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
        style={{
          cursor: draggingNode ? "grabbing" : hoverNode ? "pointer" : "grab",
          backgroundColor: "transparent",
        }}
      />
      <div className="sr-only">
        <p>{srSummary}</p>
        {anchors.map((a) => (
          <p key={a.topicId}>
            {a.title}: {a.nodeCount} node{a.nodeCount === 1 ? "" : "s"}.
          </p>
        ))}
      </div>
      <div className="pointer-events-none absolute inset-0">
        {anchors.map((a) => {
          const focused = a.topicId === focusedTopicId;
          const detail = topicDetails[a.topicId];
          const qCount = detail
            ? detail.nodes.filter((n) => n.type === "question").length
            : 0;
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
                {qCount > 0 && (
                  <span
                    className="text-forest-600 bg-forest-100/90 inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[10px] font-medium tabular-nums"
                    title={`${qCount} open question${qCount === 1 ? "" : "s"}`}
                  >
                    ? {qCount}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* Morph chrome — bottom-center; hidden while Inspect open */}
      {!inspectOpen && (
        <div className="pointer-events-none absolute inset-x-0 bottom-20 z-10 flex justify-center gap-2 px-4">
          <MorphSlider />
          <button
            type="button"
            onClick={() => void onAddChildQuestion()}
            disabled={addingQuestion}
            title="Add child question under focus (growth)"
            aria-label="Add child question under focused node"
            className={cn(
              "pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-forest-200",
              "bg-sand-100/85 px-3 py-1.5 text-[11px] font-medium text-forest-700 shadow-glass backdrop-blur-md",
              "hover:bg-sand-100 hover:border-forest-300 transition-colors",
              "disabled:opacity-50",
              "[-webkit-font-smoothing:antialiased]",
            )}
          >
            <span aria-hidden className="text-forest-500">
              ?
            </span>
            <span>问</span>
            {openQuestionCount > 0 && (
              <span className="text-forest-400 tabular-nums">{openQuestionCount}</span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
