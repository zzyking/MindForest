/**
 * Drives the live d3-force simulation behind ForestView — the engine
 * of the Obsidian-style "the graph is alive" feel.
 *
 * One rAF step = one sim.tick() + one batched position write into the
 * graphology graph (sigma repaints reactively off the graph event).
 * The loop self-terminates when alpha decays below alphaMin — physics
 * and rendering both go fully idle at rest — and `reheat` raises alpha
 * and restarts it. Dragging keeps it alive via sim.alphaTarget(>0),
 * mirroring the classic d3 drag pattern.
 */

import { useCallback, useEffect, useRef } from "react";
import type Sigma from "sigma";

import { writeSimPositionsToGraph, type ForestLayout } from "./graphBuild";

export function useSimLoop(
  layoutRef: React.RefObject<ForestLayout | null>,
  sigmaRef: React.RefObject<Sigma | null>,
) {
  const rafRef = useRef<number | null>(null);

  const step = useCallback(() => {
    rafRef.current = null;
    const layout = layoutRef.current;
    if (!layout) return;
    const { sim } = layout;
    if (sim.alpha() < sim.alphaMin() && sim.alphaTarget() < sim.alphaMin()) {
      // Cooled below threshold with no interaction holding it up —
      // sleep. The last hot frame already rendered fully indexed.
      return;
    }
    sim.tick(); // advances alpha toward alphaTarget per d3 semantics
    // writeSimPositionsToGraph also applies L3 tree-snap when near-locked.
    writeSimPositionsToGraph(layout);
    // Explicit refresh — sigma does NOT listen to graphology's batched
    // `eachNodeAttributesUpdated` event, so the position write above
    // repaints nothing on its own (verified against sigma's dist).
    // Full refresh (with indexation) keeps hover picking accurate
    // while nodes move; process cost at our graph sizes is trivial.
    sigmaRef.current?.refresh();
    rafRef.current = requestAnimationFrame(step);
  }, [layoutRef, sigmaRef]);

  /** Start the loop if it isn't already ticking. Safe to call every
   *  render — a no-op while running or when there's nothing to do. */
  const ensureRunning = useCallback(() => {
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(step);
  }, [step]);

  /** Raise alpha to at least `alpha` (never lowers it) and make sure
   *  the loop is ticking. */
  const reheat = useCallback(
    (alpha: number) => {
      const sim = layoutRef.current?.sim;
      if (!sim) return;
      if (sim.alpha() < alpha) sim.alpha(alpha);
      ensureRunning();
    },
    [layoutRef, ensureRunning],
  );

  useEffect(
    () => () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        // Null it out or the stale id makes ensureRunning think the
        // loop is still alive after a StrictMode remount — which froze
        // the whole simulation permanently (caught by smoke testing).
        rafRef.current = null;
      }
    },
    [],
  );

  return { reheat, ensureRunning };
}
