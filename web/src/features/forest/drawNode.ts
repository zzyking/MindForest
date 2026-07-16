/**
 * Soft-body appearance helpers for the morph field (sigma WebGL nodes).
 *
 * Sigma v3 draws nodes in WebGL (NodeCircleProgram) — no canvas
 * defaultDrawNode. Softness is expressed via size scale + color blend
 * in the nodeReducer, plus a static question mark drawn in the label
 * pass (see drawLabel).
 */

import { palette, withAlpha } from "./palette";
import { sizeScaleForMaterial, typeSoftness } from "./morphMap";

/** Display size for a graph node given base size, type, and material μ. */
export function softNodeSize(
  baseSize: number,
  nodeType: string | undefined,
  material: number,
): number {
  const soft = typeSoftness(nodeType ?? "misc");
  const scale = sizeScaleForMaterial(material, soft);
  return Math.max(3, baseSize * scale);
}

/**
 * Soften / harden fill color by type residual + material.
 * Near + soft types → slightly lifted (paper-resin); far → full type hue.
 */
export function softNodeColor(
  baseColor: string,
  nodeType: string | undefined,
  material: number,
): string {
  const soft = typeSoftness(nodeType ?? "misc");
  // Lift toward canvas at near μ for soft types (reads as resin, not neon).
  const lift = soft * (1 - material) * 0.28;
  if (lift <= 0.01) return baseColor;
  return blendTowardCanvas(baseColor, lift);
}

function blendTowardCanvas(hex: string, t: number): string {
  if (!hex.startsWith("#") || hex.length < 7) return hex;
  const [bgR, bgG, bgB] = palette().canvasBgRgb;
  const fr = parseInt(hex.slice(1, 3), 16);
  const fg = parseInt(hex.slice(3, 5), 16);
  const fb = parseInt(hex.slice(5, 7), 16);
  const r = Math.round(fr * (1 - t) + bgR * t)
    .toString(16)
    .padStart(2, "0");
  const g = Math.round(fg * (1 - t) + bgG * t)
    .toString(16)
    .padStart(2, "0");
  const b = Math.round(fb * (1 - t) + bgB * t)
    .toString(16)
    .padStart(2, "0");
  return `#${r}${g}${b}`;
}

/** Dim a soft color while hovering non-neighbors. */
export function dimSoftColor(color: string, alpha: number): string {
  return withAlpha(color, alpha);
}
