/**
 * Camera helpers for the forest sigma instance — pure functions over
 * `Sigma` + `Graph`, no React.
 *
 * The recurring trap here is sigma's framedGraph coordinate space: the
 * camera's `setState({x, y})` wants framed coordinates, not graph
 * coordinates, and the conversion depends on the *current* viewport
 * dimensions. `getFramedGraphPoint` does the dance once; everything
 * else goes through it.
 */

import type Graph from "graphology";
import type Sigma from "sigma";

import { cameraRatioForMu, useMorph } from "@/stores/morph";
import type { ForestCameraMode } from "@/stores/workspaceUI";
import type { NodeId, TopicDetail, TopicId } from "@/lib/types";

export interface GraphPoint {
  x: number;
  y: number;
}

export function getGraphNodePosition(graph: Graph, nodeId: NodeId): GraphPoint | null {
  if (!graph.hasNode(nodeId)) return null;
  return {
    x: graph.getNodeAttribute(nodeId, "x") as number,
    y: graph.getNodeAttribute(nodeId, "y") as number,
  };
}

function getFramedGraphPoint(sigma: Sigma, point: GraphPoint) {
  const conversion = {
    cameraState: sigma.getCamera().getState(),
    viewportDimensions: sigma.getDimensions(),
    graphDimensions: sigma.getGraphDimensions(),
    padding: sigma.getStagePadding(),
  };
  const view = sigma.graphToViewport(point, conversion);
  return sigma.viewportToFramedGraph(view, conversion);
}

/**
 * Sole writer of camera.ratio for the morph field.
 * ratio = cameraRatioForMu(μ, fitRatio) — same formula for slider + wheel.
 *
 * When `center` is given (focused node), pan so that point stays at
 * viewport center after the ratio change — morph zooms around focus,
 * never around the cursor / stray pan offset.
 */
export function syncCameraRatioToMorph(
  sigma: Sigma,
  opts?: { center?: GraphPoint | null },
): void {
  const { mu, fitRatio } = useMorph.getState();
  if (fitRatio == null || !(fitRatio > 0)) return;
  const next = cameraRatioForMu(mu, fitRatio);
  const cam = sigma.getCamera();
  if (Math.abs(cam.ratio - next) > 1e-6) {
    cam.setState({ ratio: next });
  }
  if (opts?.center) {
    // After ratio update: framed conversion uses the new ratio, so this
    // places `center` at viewport middle (not under the pointer).
    setCameraToPoint(sigma, opts.center);
  }
}

export function animateCameraToPoint(
  sigma: Sigma,
  point: GraphPoint,
  options: { duration: number },
) {
  const framed = getFramedGraphPoint(sigma, point);
  // Pan only — never touch ratio (morph owns distance).
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) {
    sigma.getCamera().setState({ x: framed.x, y: framed.y });
    return;
  }
  sigma.getCamera().animate({ x: framed.x, y: framed.y }, { duration: options.duration });
}

export function setCameraToPoint(sigma: Sigma, point: GraphPoint) {
  // Pan only — preserve morph ratio.
  const framed = getFramedGraphPoint(sigma, point);
  sigma.getCamera().setState({ x: framed.x, y: framed.y });
}

export function resolveCameraTarget({
  focusedNodeId,
  focusedTopicId,
  cameraMode,
  graph,
  topicDetails,
}: {
  focusedNodeId: NodeId;
  focusedTopicId: TopicId;
  cameraMode: ForestCameraMode;
  graph: Graph;
  topicDetails: Record<TopicId, TopicDetail | undefined>;
}): GraphPoint | null {
  if (cameraMode === "node") {
    return getGraphNodePosition(graph, focusedNodeId);
  }

  const detail = topicDetails[focusedTopicId];
  const topicRootTarget = detail ? getGraphNodePosition(graph, detail.root_node_id) : null;
  if (topicRootTarget) return topicRootTarget;

  return getGraphNodePosition(graph, focusedNodeId);
}

export function getForestCameraMode({
  focusedNodeId,
  focusedTopicId,
  intent,
}: {
  focusedNodeId: NodeId;
  focusedTopicId: TopicId;
  intent: {
    targetNodeId: NodeId;
    topicId: TopicId;
    mode: ForestCameraMode;
  } | null;
}): ForestCameraMode | null {
  if (!intent) return "node";
  if (intent.targetNodeId === focusedNodeId && intent.topicId === focusedTopicId) {
    return intent.mode;
  }
  return null;
}

/**
 * Frame the camera so the whole graph is visible, optionally centred
 * on a specific graph point (the focused node). With a centre given,
 * the half-extents are measured from that point to the farthest bbox
 * edge — "my node is centred" and "everything is visible" hold at the
 * same time, so the initial framing never needs a corrective jump.
 *
 * Padding 1.45 rather than a snug 1.25 because the floating dock
 * overlays the bottom of the viewport and a snug fit reads as "the
 * tree doesn't fit on screen". (It was 1.6 when the agent bar was a
 * second always-on chrome row; the bar now expands on demand, so the
 * standing overlay is just the dock.) The mount fit runs against the
 * SETTLED positions (warm mounts resume them; cold mounts presettle to
 * learn them), so it no longer has to pre-compensate for the relax
 * expanding a seed-sized fit outward.
 */
export function fitCameraToGraph(
  s: Sigma,
  graph: Graph,
  opts?: { center?: GraphPoint },
) {
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
  const cx = opts?.center?.x ?? (minX + maxX) / 2;
  const cy = opts?.center?.y ?? (minY + maxY) / 2;
  const halfW = Math.max(1, maxX - cx, cx - minX);
  const halfH = Math.max(1, maxY - cy, cy - minY);
  const container = s.getContainer();
  const vw = container.clientWidth || 1;
  const vh = container.clientHeight || 1;
  const padding = 1.45;
  const probeA = s.viewportToGraph({ x: 0, y: 0 });
  const probeB = s.viewportToGraph({ x: vw, y: 0 });
  const graphUnitsPerViewportWidth = Math.abs(probeB.x - probeA.x);
  const wantedWidth = halfW * 2 * padding;
  const wantedHeight = halfH * 2 * padding;
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
