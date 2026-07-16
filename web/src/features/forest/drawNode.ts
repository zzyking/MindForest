/**
 * Soft-body appearance for the morph field.
 *
 * Sigma v3 nodes are WebGL discs. Soft resin language is layered as:
 *   1. WebGL disc size + fill (nodeReducer) — hard core
 *   2. Canvas label-pass halos (drawSoftBody) — soft membrane at near μ
 *   3. Edge alpha/weight from material
 *
 * Question marks stay in drawLabel (static, no pulse).
 */

import { palette, withAlpha } from "./palette";
import { sizeScaleForMaterial, typeSoftness } from "./morphMap";

/** Display size for WebGL disc given base size, type, and material μ. */
export function softNodeSize(
  baseSize: number,
  nodeType: string | undefined,
  material: number,
): number {
  const soft = typeSoftness(nodeType ?? "misc");
  const scale = sizeScaleForMaterial(material, soft);
  return Math.max(2.5, baseSize * scale);
}

/**
 * Soften / harden fill: near = lifted paper-resin; far = denser type ink.
 * Soft types stay more lifted even at mid μ.
 */
export function softNodeColor(
  baseColor: string,
  nodeType: string | undefined,
  material: number,
): string {
  const soft = typeSoftness(nodeType ?? "misc");
  // Near: lift toward sand (resin). Far: slight deepen toward ink.
  const nearLift = soft * (1 - material) * 0.42;
  if (material < 0.55) {
    if (nearLift <= 0.01) return baseColor;
    return blendTowardCanvas(baseColor, nearLift);
  }
  // Far band: firm types denser
  const deepen = (1 - soft) * (material - 0.55) * 0.35;
  if (deepen <= 0.01) return baseColor;
  return blendTowardInk(baseColor, deepen);
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

function blendTowardInk(hex: string, t: number): string {
  if (!hex.startsWith("#") || hex.length < 7) return hex;
  const ink = palette().ink;
  if (!ink.startsWith("#") || ink.length < 7) return hex;
  const ir = parseInt(ink.slice(1, 3), 16);
  const ig = parseInt(ink.slice(3, 5), 16);
  const ib = parseInt(ink.slice(5, 7), 16);
  const fr = parseInt(hex.slice(1, 3), 16);
  const fg = parseInt(hex.slice(3, 5), 16);
  const fb = parseInt(hex.slice(5, 7), 16);
  const r = Math.round(fr * (1 - t) + ir * t)
    .toString(16)
    .padStart(2, "0");
  const g = Math.round(fg * (1 - t) + ig * t)
    .toString(16)
    .padStart(2, "0");
  const b = Math.round(fb * (1 - t) + ib * t)
    .toString(16)
    .padStart(2, "0");
  return `#${r}${g}${b}`;
}

/** Dim a soft color while hovering non-neighbors. */
export function dimSoftColor(color: string, alpha: number): string {
  return withAlpha(color, alpha);
}

/**
 * Canvas soft membrane under/around a node. Strong near, gone far.
 * Called from the label draw path (forceLabel on every node).
 */
export function drawSoftBody(
  context: CanvasRenderingContext2D,
  data: { x: number; y: number; size: number; color?: string; nodeType?: string },
  material: number,
) {
  // Past ~0.82 material, pure graph — no halo (hard dots only).
  if (material >= 0.82) return;

  const soft = typeSoftness(data.nodeType ?? "misc");
  // Near → thick halo; far → thin then gone. Soft types keep more membrane.
  const nearness = 1 - material;
  const haloStrength = nearness * (0.55 + soft * 0.45);
  if (haloStrength < 0.04) return;

  const r = Math.max(2.5, data.size);
  const feather = r * (0.55 + soft * 0.9) * nearness + r * 0.15;
  const outer = r + feather;
  const color = data.color || palette().dim;
  const [cr, cg, cb] = hexToRgb(color);

  const grad = context.createRadialGradient(data.x, data.y, r * 0.2, data.x, data.y, outer);
  const coreA = 0.22 * haloStrength;
  const midA = 0.14 * haloStrength;
  grad.addColorStop(0, `rgba(${cr},${cg},${cb},${coreA})`);
  grad.addColorStop(0.45, `rgba(${cr},${cg},${cb},${midA})`);
  grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);

  context.save();
  context.beginPath();
  context.arc(data.x, data.y, outer, 0, Math.PI * 2);
  context.fillStyle = grad;
  context.fill();

  // Soft types near: faint outer ring (membrane edge)
  if (soft > 0.5 && nearness > 0.35) {
    context.beginPath();
    context.arc(data.x, data.y, r + feather * 0.55, 0, Math.PI * 2);
    context.strokeStyle = `rgba(${cr},${cg},${cb},${0.18 * haloStrength})`;
    context.lineWidth = 1 + nearness * soft * 1.5;
    context.stroke();
  }
  context.restore();
}

function hexToRgb(hex: string): [number, number, number] {
  if (!hex.startsWith("#") || (hex.length !== 7 && hex.length !== 4)) {
    return palette().canvasBgRgb;
  }
  if (hex.length === 4) {
    return [
      parseInt(hex[1]! + hex[1]!, 16),
      parseInt(hex[2]! + hex[2]!, 16),
      parseInt(hex[3]! + hex[3]!, 16),
    ];
  }
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}
