/**
 * Hover state machine for the forest graph — owns the 0..1 fade
 * progress, the neighbour set of the hovered node, and the "sticky"
 * dim set that keeps hovered/neighbour nodes opaque while the fade-out
 * animation plays after the pointer leaves.
 *
 * Everything sigma's reducers need is exposed through refs + a stable
 * `resolveDimSet()` so reducers can read per-frame state without the
 * sigma instance being recreated on every hover tick.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type Sigma from "sigma";

import type { NodeId } from "@/lib/types";

export interface DimSet {
  hovered: NodeId | null;
  neighbors: Set<NodeId>;
}

export function useHoverDim(
  sigmaRef: React.RefObject<Sigma | null>,
  neighbors: Map<NodeId, Set<NodeId>>,
) {
  // Hover state — both the node id and its neighbour set, computed
  // once per hover change so the reducer can do a single Set lookup.
  const [hoverNode, setHoverNode] = useState<NodeId | null>(null);
  const progressRef = useRef(0);
  const animFrameRef = useRef<number | null>(null);
  /** The node sigma currently reports as hovered (null after leave). */
  const hoveredRef = useRef<NodeId | null>(null);
  const neighborsRef = useRef<Set<NodeId>>(new Set());
  // Keep track of the active set during fade-out so they remain opaque.
  const activeDimSetRef = useRef<DimSet>({ hovered: null, neighbors: new Set() });

  // New graph → new id space; drop the stale neighbour snapshot.
  useEffect(() => {
    neighborsRef.current = new Set();
  }, [neighbors]);

  const setHover = useCallback(
    (id: NodeId | null) => {
      hoveredRef.current = id;
      const newNeighbors: Set<NodeId> = id
        ? (neighbors.get(id) ?? new Set<NodeId>())
        : new Set<NodeId>();
      neighborsRef.current = newNeighbors;
      if (id) {
        activeDimSetRef.current = { hovered: id, neighbors: newNeighbors };
      }
      setHoverNode(id);
    },
    [neighbors],
  );

  /** What the reducers should dim against right now: the live hover
   *  while the pointer is on a node, the sticky snapshot during
   *  fade-out. */
  const resolveDimSet = useCallback((): DimSet => {
    if (hoveredRef.current !== null) {
      return { hovered: hoveredRef.current, neighbors: neighborsRef.current };
    }
    return activeDimSetRef.current;
  }, []);

  // Animate progress toward 1 (hover) or 0 (leave), refreshing sigma
  // each frame so the reducers re-run with the new progress.
  useEffect(() => {
    if (!sigmaRef.current) return;

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    const target = hoverNode ? 1 : 0;
    if (reduceMotion) {
      progressRef.current = target;
      sigmaRef.current.refresh();
      return;
    }

    const start = progressRef.current;
    const startTime = performance.now();
    const duration = 250;

    const tick = (now: number) => {
      const s = sigmaRef.current;
      if (!s) {
        // Sigma was killed mid-fade (view rebuild) — stop scheduling.
        animFrameRef.current = null;
        return;
      }
      const t = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      progressRef.current = start + (target - start) * eased;
      s.refresh();
      if (t < 1) {
        animFrameRef.current = requestAnimationFrame(tick);
      } else {
        animFrameRef.current = null;
      }
    };

    animFrameRef.current = requestAnimationFrame(tick);

    return () => {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [hoverNode, sigmaRef]);

  return { hoverNode, setHover, progressRef, resolveDimSet };
}
