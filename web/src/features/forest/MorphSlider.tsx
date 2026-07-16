/**
 * Morph control: continuous 近 ↔ 远.
 *
 * Fully controlled by useMorph.mu — no native range value quirks.
 * Wheel on empty field and drag on this scrubber both call setMu;
 * thumb + fill are pure CSS from the store.
 */

import { useCallback, useRef } from "react";

import { cn } from "@/lib/cn";
import { useMorph } from "@/stores/morph";

interface Props {
  className?: string;
  inert?: boolean;
}

export function MorphSlider({ className, inert }: Props) {
  const mu = useMorph((s) => s.mu);
  const setMu = useMorph((s) => s.setMu);
  const frozen = useMorph((s) => s.frozen);
  const disabled = Boolean(inert || frozen);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const muFromClientX = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track) return useMorph.getState().mu;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return useMorph.getState().mu;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      e.preventDefault();
      dragging.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setMu(muFromClientX(e.clientX));
    },
    [disabled, muFromClientX, setMu],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current || disabled) return;
      setMu(muFromClientX(e.clientX));
    },
    [disabled, muFromClientX, setMu],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragging.current = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }, []);

  const pct = `${(mu * 100).toFixed(2)}%`;

  return (
    <div
      className={cn(
        "pointer-events-auto flex items-center gap-2.5 rounded-full border border-forest-200",
        "bg-sand-100/85 px-3 py-1.5 shadow-glass backdrop-blur-md",
        "[-webkit-font-smoothing:antialiased]",
        disabled && "pointer-events-none opacity-40",
        className,
      )}
      role="group"
      aria-label="Morph distance"
    >
      <span className="text-forest-500 select-none text-[11px] font-medium tracking-wide">
        近
      </span>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={Number(mu.toFixed(3))}
        aria-valuetext={muLabel(mu)}
        aria-label="近 to 远 — distance and form"
        aria-disabled={disabled}
        title="近 ↔ 远 — camera distance and soft form (not maturity)"
        className="relative h-5 w-44 cursor-pointer touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(e) => {
          if (disabled) return;
          const step = e.shiftKey ? 0.1 : 0.02;
          if (e.key === "ArrowRight" || e.key === "ArrowUp") {
            e.preventDefault();
            setMu(useMorph.getState().mu + step);
          } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
            e.preventDefault();
            setMu(useMorph.getState().mu - step);
          } else if (e.key === "Home") {
            e.preventDefault();
            setMu(0);
          } else if (e.key === "End") {
            e.preventDefault();
            setMu(1);
          }
        }}
      >
        {/* Track */}
        <div className="bg-forest-200/80 absolute top-1/2 right-0 left-0 h-1.5 -translate-y-1/2 overflow-hidden rounded-full">
          <div
            className="bg-forest-700 h-full rounded-full"
            style={{ width: pct }}
          />
        </div>
        {/* Thumb — left% from store μ; transforms so center sits on value */}
        <div
          className={cn(
            "border-forest-800 bg-forest-800 absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2",
            "rounded-full border shadow-soft",
          )}
          style={{ left: pct }}
          aria-hidden
        />
      </div>
      <span className="text-forest-500 select-none text-[11px] font-medium tracking-wide">
        远
      </span>
    </div>
  );
}

function muLabel(mu: number): string {
  if (mu < 0.25) return "近 — close resin";
  if (mu < 0.6) return "中 — grove";
  return "远 — overview";
}
