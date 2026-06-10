/**
 * Camera anchor — the graph point we *want* to keep at viewport center
 * across container resizes (sidebar toggle). Updated whenever the
 * user/system makes a deliberate camera move: initial fit,
 * focus-on-node, click, forestCameraIntent. NOT updated on every
 * render — so an interim sidebar resize doesn't read whatever happens
 * to be at the screen center during the transition.
 */

import { useEffect, useRef } from "react";
import type Sigma from "sigma";

import { setCameraToPoint, type GraphPoint } from "./camera";

/**
 * Returns the anchor ref. Callers assign `anchorRef.current` at each
 * deliberate camera move; this hook re-centers that point while the
 * sidebar's grid track animates over ~350ms.
 *
 * Per frame we force `sigma.resize(true)` before `setCameraToPoint` —
 * sigma's internal ResizeObserver batches its dimension updates and
 * can lag the actual DOM size during a layout-property transition.
 * `setCameraToPoint` reads `sigma.getDimensions()` to compute the
 * framedGraph offset, so stale dimensions = off-center anchor.
 */
export function useCameraAnchor(
  sigmaRef: React.RefObject<Sigma | null>,
  sidebarOpen: boolean,
) {
  const anchorRef = useRef<GraphPoint | null>(null);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    if (!sigmaRef.current) return;

    const startTime = performance.now();
    const duration = 380;
    let rafId = 0;
    const tick = () => {
      const live = sigmaRef.current;
      if (!live) return;
      live.resize(true);
      setCameraToPoint(live, anchor);
      if (performance.now() - startTime < duration) {
        rafId = requestAnimationFrame(tick);
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [sidebarOpen, sigmaRef]);

  return anchorRef;
}
