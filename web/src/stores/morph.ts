/**
 * Morph axis μ — user-owned near↔far continuum for the field.
 *
 * Session-only (not URL, not localStorage). Maturity / node count never
 * writes here. Inspect open freezes μ (snapshot + restore).
 *
 * Dual-zone (UI_VISION §3.1):
 *   - Camera dolly tracks μ continuously (small moves = survey).
 *   - Material blend lags with hysteresis so fine moves don't
 *     rematerialize the world.
 *
 * Cold open: fixed Grove mid (MU_COLD), not empty Mist.
 */

import { create } from "zustand";

/** Cold-open / Grove lean — mid on the continuum. */
export const MU_COLD = 0.45;

/** Half-width of the pure-dolly band around the last material μ.
 *  Small enough that a short slider drag still rematerializes; large
 *  enough that fine wheel ticks survey without popping form. */
const HYSTERESIS = 0.045;

/** Discrete stations when prefers-reduced-motion. */
const STATIONS = [0.2, 0.45, 0.85] as const;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function snapStation(v: number): number {
  let best: number = STATIONS[0]!;
  let bestD = Math.abs(v - best);
  for (const s of STATIONS) {
    const d = Math.abs(v - s);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/**
 * Dual-zone mapping from raw μ → { camera, material }.
 *
 * Camera follows μ 1:1 (dolly always).
 * Material always eases toward μ — never freezes — so wheel and slider
 * share one family. Dual-zone is rate, not a hard gate:
 *   - |Δ| ≤ hysteresis → slow catch-up (survey without hard pop)
 *   - |Δ| > hysteresis → fast catch-up (form + distance together)
 *
 * (Earlier freeze-inside-band made wheel feel “camera only” while a
 *  slider jump rematerialized — same setMu path, different step size.)
 */
export function mapMorph(
  mu: number,
  materialPrev: number,
): { camera: number; material: number } {
  const camera = clamp01(mu);
  const delta = camera - materialPrev;
  if (Math.abs(delta) < 1e-6) {
    return { camera, material: materialPrev };
  }
  const rate = Math.abs(delta) <= HYSTERESIS ? 0.4 : 0.9;
  const material = clamp01(materialPrev + delta * rate);
  return { camera, material };
}

/**
 * Camera ratio relative to a fitted overview ratio.
 * μ=0 → close intimacy; μ=1 → high overview.
 * Grove (0.45) sits near the fitted overview.
 */
export function cameraRatioForMu(mu: number, fitRatio: number): number {
  // Dramatic dolly: near ~0.22× fit (inside a thought), far ~2.4× fit.
  const t = clamp01(mu);
  const scale = 0.22 + t * 2.2; // 0→0.22, 0.45→~1.21, 1→2.42
  return Math.max(0.04, Math.min(5, fitRatio * scale));
}

/** Node size multiplier from material μ + type residual softness. */
export function sizeScaleForMaterial(material: number, typeSoftness: number): number {
  // Near: large resin bodies; far: small constellation dots.
  // Soft types keep residual bulk even at high material.
  const nearBoost = 2.65 - material * 2.05; // 2.65 → 0.60
  const residual = typeSoftness * (0.35 * (1 - material) + 0.12);
  return Math.max(0.45, nearBoost + residual);
}

/**
 * Type → residual softness ∈ [0,1] (idea/question soft; concept/fact firm).
 * Not maturity-from-count — pure type language.
 */
export function typeSoftness(type: string): number {
  switch (type) {
    case "idea":
      return 0.95;
    case "question":
      return 0.85;
    case "misc":
      return 0.7;
    case "example":
      return 0.55;
    case "source":
      return 0.4;
    case "task":
      return 0.35;
    case "concept":
      return 0.25;
    case "fact":
      return 0.15;
    default:
      return 0.5;
  }
}

/** Edge stroke weight / alpha blend from material (near softer/fainter). */
export function edgeStyleForMaterial(material: number): {
  treeAlpha: number;
  linkAlpha: number;
  treeSize: number;
  linkSize: number;
} {
  // Near: almost-membrane (faint sap); far: hard graph strokes.
  const treeAlpha = 0.08 + material * 0.92;
  const linkAlpha = 0.02 + material * 0.85;
  const treeSize = 0.45 + material * 1.1;
  const linkSize = 0.5 + material * 1.4;
  return { treeAlpha, linkAlpha, treeSize, linkSize };
}

interface MorphState {
  /** User control value ∈ [0,1]. */
  mu: number;
  /** Lagged material channel (hysteresis). */
  material: number;
  /** Fit ratio captured at field mount — base for dolly. */
  fitRatio: number | null;
  /** While Inspect is open, μ is frozen. */
  frozen: boolean;
  snapshotMu: number | null;
  snapshotMaterial: number | null;

  setMu: (next: number) => void;
  /** Relative nudge (wheel / pinch). Positive = farther. */
  nudgeMu: (delta: number) => void;
  setFitRatio: (ratio: number) => void;
  freezeForInspect: () => void;
  restoreAfterInspect: () => void;
}

export const useMorph = create<MorphState>((set, get) => ({
  mu: MU_COLD,
  material: MU_COLD,
  fitRatio: null,
  frozen: false,
  snapshotMu: null,
  snapshotMaterial: null,

  setMu: (next) => {
    const s = get();
    if (s.frozen) return;
    let mu = clamp01(next);
    if (prefersReducedMotion()) mu = snapStation(mu);
    const { camera, material } = mapMorph(mu, s.material);
    set({ mu: camera, material });
  },

  nudgeMu: (delta) => {
    const s = get();
    if (s.frozen) return;
    // Throttle-friendly: caller should pass small deltas (~0.02–0.06).
    get().setMu(s.mu + delta);
  },

  setFitRatio: (ratio) => {
    if (!(ratio > 0) || !Number.isFinite(ratio)) return;
    set({ fitRatio: ratio });
  },

  freezeForInspect: () => {
    const s = get();
    if (s.frozen) return;
    set({
      frozen: true,
      snapshotMu: s.mu,
      snapshotMaterial: s.material,
    });
  },

  restoreAfterInspect: () => {
    const s = get();
    if (!s.frozen) return;
    const mu = s.snapshotMu ?? s.mu;
    const material = s.snapshotMaterial ?? s.material;
    set({
      frozen: false,
      mu,
      material,
      snapshotMu: null,
      snapshotMaterial: null,
    });
  },
}));
