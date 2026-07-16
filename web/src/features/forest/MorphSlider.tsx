/**
 * Visible morph control: continuous 近 ↔ 远.
 * Bound to useMorph.mu — wheel (empty field) and this scrubber are the
 * same value; the thumb + fill track the store on every setMu.
 */

import { useMorph } from "@/stores/morph";
import { cn } from "@/lib/cn";

interface Props {
  className?: string;
  /** When true, slider is non-interactive (Inspect open). */
  inert?: boolean;
}

export function MorphSlider({ className, inert }: Props) {
  const mu = useMorph((s) => s.mu);
  const setMu = useMorph((s) => s.setMu);
  const frozen = useMorph((s) => s.frozen);
  const disabled = Boolean(inert || frozen);
  const pct = Math.round(mu * 1000) / 10; // 0.0–100.0

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
      onWheel={(e) => {
        // Wheel over the chrome also morphs (same family as empty field).
        if (disabled) return;
        e.preventDefault();
        e.stopPropagation();
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16;
        if (e.deltaMode === 2) dy *= 400;
        setMu(useMorph.getState().mu + dy / 800);
      }}
    >
      <span className="text-forest-500 select-none text-[11px] font-medium tracking-wide">
        近
      </span>
      <div className="relative h-1.5 w-40">
        {/* Track + fill driven by store so wheel updates are visible */}
        <div
          aria-hidden
          className="absolute inset-0 overflow-hidden rounded-full bg-forest-200/80"
        >
          <div
            className="bg-forest-700 h-full rounded-full transition-[width] duration-75 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={mu}
          disabled={disabled}
          onInput={(e) => setMu(Number((e.target as HTMLInputElement).value))}
          onChange={(e) => setMu(Number(e.target.value))}
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={mu}
          aria-valuetext={muLabel(mu)}
          aria-label="近 to 远 — distance and form"
          title="近 ↔ 远 — camera distance and soft form (not maturity)"
          className={cn(
            "absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent",
            // Transparent track; fill is the div behind.
            "[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full",
            "[&::-webkit-slider-runnable-track]:bg-transparent",
            "[&::-webkit-slider-thumb]:relative [&::-webkit-slider-thumb]:-mt-1",
            "[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5",
            "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full",
            "[&::-webkit-slider-thumb]:bg-forest-800 [&::-webkit-slider-thumb]:shadow-soft",
            "[&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-75",
            "[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full",
            "[&::-moz-range-track]:bg-transparent",
            "[&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5",
            "[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0",
            "[&::-moz-range-thumb]:bg-forest-800",
          )}
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
