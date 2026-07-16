/**
 * Morph axis μ — user-owned near↔far continuum for the field.
 *
 * Session-only (not URL, not localStorage). Maturity / node count never
 * writes here. Inspect open freezes μ (snapshot + restore).
 *
 * Wheel and slider are one control family: both write absolute μ, and
 * camera + material read the same μ (no lag channel). Soft-form change
 * is continuous along μ, not a separate delayed track — delayed material
 * made wheel feel “dolly only” while the slider rematerialized.
 *
 * Cold open: fixed Grove mid (MU_COLD), not empty Mist.
 */

import { create } from "zustand";

/** Cold-open / Grove lean — mid on the continuum. */
export const MU_COLD = 0.45;

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
 * Camera + material share μ 1:1 (wheel ≡ slider).
 * `materialPrev` kept for call-site compatibility; ignored.
 */
export function mapMorph(
  mu: number,
  _materialPrev?: number,
): { camera: number; material: number } {
  const v = clamp01(mu);
  return { camera: v, material: v };
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
  /** User control value ∈ [0,1] — drives camera + material together. */
  mu: number;
  /** Same as mu (alias for render sites that read material). */
  material: number;
  /** Fit ratio captured at field mount — base for dolly. */
  fitRatio: number | null;
  /** While Inspect is open, μ is frozen. */
  frozen: boolean;
  snapshotMu: number | null;

  setMu: (next: number) => void;
  /** Relative nudge (wheel / pinch). Positive = farther. Same as setMu(mu+δ). */
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

  setMu: (next) => {
    const s = get();
    if (s.frozen) return;
    let mu = clamp01(next);
    if (prefersReducedMotion()) mu = snapStation(mu);
    const { camera, material } = mapMorph(mu);
    set({ mu: camera, material });
  },

  nudgeMu: (delta) => {
    const s = get();
    if (s.frozen) return;
    get().setMu(s.mu + delta);
  },

  setFitRatio: (ratio) => {
    // Mount-only baseline. Never overwrite from a live camera.ratio
    // (that would bake in a prior morph and fight the slider formula).
    if (!(ratio > 0) || !Number.isFinite(ratio)) return;
    if (get().fitRatio != null) return;
    set({ fitRatio: ratio });
  },

  freezeForInspect: () => {
    const s = get();
    if (s.frozen) return;
    set({ frozen: true, snapshotMu: s.mu });
  },

  restoreAfterInspect: () => {
    const s = get();
    if (!s.frozen) return;
    const mu = s.snapshotMu ?? s.mu;
    set({ frozen: false, mu, material: mu, snapshotMu: null });
  },
}));
