/**
 * Elastic node dragging for the live forest simulation — the classic
 * d3-force drag pattern wired into sigma's mouse captor.
 *
 * While dragging, the node's fx/fy pin tracks the pointer (in graph
 * coords) and the simulation holds alphaTarget 0.3, so the spring
 * forces drag the neighbourhood along — the Obsidian rubber-band feel.
 * Release clears the pin and lets alpha decay back to sleep.
 *
 * Sigma normalizes graph coords against the live bounding box on every
 * refresh; freezing it via setCustomBBox on the first interaction
 * (sigma's documented drag recipe) stops the whole constellation from
 * rescaling when a node is dragged past the current extent.
 */

import type Sigma from "sigma";

import type { NodeId } from "@/lib/types";
import type { ForestLayout, SimNode } from "./graphBuild";

interface MouseLikeEvent {
  x: number;
  y: number;
  original: Event;
  preventSigmaDefault: () => void;
}

export interface NodeDragHandle {
  /** True when the pointer travelled far enough since downNode that
   *  the subsequent clickNode should be treated as a drag, not a
   *  navigation click. */
  wasDragged: () => boolean;
  dispose: () => void;
}

const CLICK_SLOP_PX = 4;

export function wireNodeDrag(
  s: Sigma,
  layout: ForestLayout,
  ensureRunning: () => void,
  onDragChange: (dragging: boolean) => void,
): NodeDragHandle {
  let dragged: SimNode | null = null;
  let moved = false;
  let downX = 0;
  let downY = 0;
  const captor = s.getMouseCaptor();

  const onMouseDownBody = () => {
    // Freeze coordinate normalization before the first possible drag.
    if (!s.getCustomBBox()) s.setCustomBBox(s.getBBox());
  };

  const onDownNode = ({ node, event }: { node: string; event: { x: number; y: number } }) => {
    const sn = layout.nodeById.get(node as NodeId);
    if (!sn) return;
    dragged = sn;
    moved = false;
    downX = event.x;
    downY = event.y;
    sn.fx = sn.x ?? 0;
    sn.fy = sn.y ?? 0;
    // Hold the simulation warm for the whole gesture; the loop's sleep
    // check respects alphaTarget, so it keeps ticking even when alpha
    // has converged.
    layout.sim.alphaTarget(0.3);
    ensureRunning();
    onDragChange(true);
  };

  const onMoveBody = (e: MouseLikeEvent) => {
    if (!dragged) return;
    if (!moved && Math.hypot(e.x - downX, e.y - downY) > CLICK_SLOP_PX) moved = true;
    const pos = s.viewportToGraph(e);
    dragged.fx = pos.x;
    dragged.fy = pos.y;
    // Keep sigma from panning the camera with the gesture.
    e.preventSigmaDefault();
    e.original.preventDefault();
    e.original.stopPropagation();
  };

  const onMouseUp = () => {
    if (!dragged) return;
    dragged.fx = null;
    dragged.fy = null;
    layout.sim.alphaTarget(0);
    dragged = null;
    onDragChange(false);
    // `moved` deliberately survives until the next downNode — sigma
    // emits clickNode right after mouseup and the handler reads it.
  };

  s.on("downNode", onDownNode);
  captor.on("mousedown", onMouseDownBody);
  captor.on("mousemovebody", onMoveBody);
  captor.on("mouseup", onMouseUp);

  return {
    wasDragged: () => moved,
    dispose: () => {
      s.off("downNode", onDownNode);
      captor.off("mousedown", onMouseDownBody);
      captor.off("mousemovebody", onMoveBody);
      captor.off("mouseup", onMouseUp);
    },
  };
}
