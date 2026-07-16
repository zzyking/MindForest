/**
 * Visible morph control: continuous 近 ↔ 远.
 * Same value family as empty-field wheel (useMorph). Hidden / inert
 * while Inspect is open (parent gates visibility).
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
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={mu}
        disabled={disabled}
        onChange={(e) => setMu(Number(e.target.value))}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={mu}
        aria-valuetext={muLabel(mu)}
        aria-label="近 to 远 — distance and form"
        title="近 ↔ 远 — camera distance and soft form (not maturity)"
        className={cn(
          "h-1.5 w-36 cursor-pointer appearance-none rounded-full bg-forest-200/80",
          "accent-forest-700",
          "[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5",
          "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full",
          "[&::-webkit-slider-thumb]:bg-forest-800 [&::-webkit-slider-thumb]:shadow-soft",
          "[&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5",
          "[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0",
          "[&::-moz-range-thumb]:bg-forest-800",
        )}
      />
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
