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

/** Half-width of the pure-dolly band around the last material μ. */
const HYSTERESIS = 0.07;

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
 * Camera follows μ 1:1; material only advances when μ leaves the
 * hysteresis band around the previous material value.
 */
export function mapMorph(
  mu: number,
  materialPrev: number,
): { camera: number; material: number } {
  const camera = clamp01(mu);
  const delta = camera - materialPrev;
  if (Math.abs(delta) <= HYSTERESIS) {
    return { camera, material: materialPrev };
  }
  // Past hysteresis: material eases toward camera (not a hard snap).
  const step = delta > 0 ? delta - HYSTERESIS : delta + HYSTERESIS;
  const material = clamp01(materialPrev + step * 0.55);
  return { camera, material };
}

/**
 * Camera ratio relative to a fitted overview ratio.
 * μ=0 → closer (smaller ratio); μ=1 → farther (larger ratio).
 * Grove (0.45) sits near the fitted overview.
 */
export function cameraRatioForMu(mu: number, fitRatio: number): number {
  // fitRatio ≈ overview; scale so mid ≈ fit, near ~0.45×, far ~1.65×.
  const t = clamp01(mu);
  const scale = 0.42 + t * 1.35; // 0→0.42, 0.45→~1.03, 1→1.77
  return Math.max(0.05, Math.min(4, fitRatio * scale));
}

/** Node size multiplier from material μ + type residual softness. */
export function sizeScaleForMaterial(material: number, typeSoftness: number): number {
  // Near (0): larger bodies; far (1): smaller graph dots.
  // Soft types keep a residual size bump even at high material.
  const nearBoost = 1.55 - material * 0.85; // 1.55 → 0.70
  const residual = typeSoftness * (0.12 + material * 0.08);
  return nearBoost + residual;
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
  // material 0 (near): faint membrane; 1 (far): harder strokes
  const treeAlpha = 0.25 + material * 0.75;
  const linkAlpha = 0.15 + material * 0.7;
  const treeSize = 0.7 + material * 0.5;
  const linkSize = 0.9 + material * 0.7;
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
