/**
 * Canvas palette for the forest graph. Sigma renders to canvas/webgl so
 * it can't reach CSS vars from inside its render loop — read them once
 * at module-first-use, cache the result, and serve a plain JS object
 * from there. tokens.css is the single source of truth; adjust shades
 * there.
 */

import type { NodeType } from "@/lib/types";

export interface Palette {
  ink: string;
  dim: string;
  accent: string;
  accentDeep: string;
  label: string;
  /** RGB triplet form of `label`, so callers can splice an alpha
   *  channel in (`rgba(${r}, ${g}, ${b}, ${a})`) without re-parsing. */
  labelRgb: [number, number, number];
  /** Canvas backdrop (sand-100) — used both as the hover-capsule fill
   *  and as the blend target in `withAlpha`. */
  canvasBg: string;
  canvasBgRgb: [number, number, number];
  /** Hairline border for canvas-drawn chrome (forest-200). */
  border: string;
  borderRgb: [number, number, number];
  types: Record<NodeType, string>;
}

function hexToRgb(hex: string): [number, number, number] {
  const c = hex.replace("#", "").trim();
  return [
    parseInt(c.slice(0, 2), 16),
    parseInt(c.slice(2, 4), 16),
    parseInt(c.slice(4, 6), 16),
  ];
}

let _palette: Palette | null = null;

export function palette(): Palette {
  if (_palette) return _palette;
  const cs = getComputedStyle(document.documentElement);
  // Fallbacks match tokens.css 1:1. If Tailwind's @theme block ever
  // stops emitting a custom var (e.g. it gets pruned as "unused"), the
  // canvas keeps a defined colour instead of "" which would draw
  // nothing.
  const v = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  const label = v("--color-forest-canvas-label", "#3e4b41");
  const canvasBg = v("--color-sand-100", "#f9f7f2");
  const border = v("--color-forest-200", "#ccd6d1");
  _palette = {
    ink: v("--color-forest-canvas-ink", "#152019"),
    dim: v("--color-forest-canvas-dim", "#b8c8be"),
    accent: v("--color-accent", "#d47a5d"),
    accentDeep: v("--color-accent-deep", "#a85c3f"),
    label,
    labelRgb: hexToRgb(label),
    canvasBg,
    canvasBgRgb: hexToRgb(canvasBg),
    border,
    borderRgb: hexToRgb(border),
    types: {
      concept: v("--color-type-concept", "#7b9082"),
      idea: v("--color-type-idea", "#a98aa0"),
      fact: v("--color-type-fact", "#a8b3a0"),
      source: v("--color-type-source", "#c1ad7c"),
      example: v("--color-type-example", "#d4a574"),
      question: v("--color-type-question", "#b8a36d"),
      task: v("--color-type-task", "#7e9ba8"),
      misc: v("--color-type-misc", "#9d9b91"),
    },
  };
  return _palette;
}

/** Blend a #rrggbb with the canvas background to simulate alpha —
 *  sigma node/edge colors are opaque, so "dimming" is a pre-blend. */
export function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("rgba(")) return color;
  if (!color.startsWith("#")) return color;

  const n = color.length === 7 ? color : color === "#000" ? "#000000" : color;
  const [bgR, bgG, bgB] = palette().canvasBgRgb;

  const fgR = parseInt(n.slice(1, 3), 16);
  const fgG = parseInt(n.slice(3, 5), 16);
  const fgB = parseInt(n.slice(5, 7), 16);

  const r = Math.round(fgR * alpha + bgR * (1 - alpha)).toString(16).padStart(2, "0");
  const g = Math.round(fgG * alpha + bgG * (1 - alpha)).toString(16).padStart(2, "0");
  const b = Math.round(fgB * alpha + bgB * (1 - alpha)).toString(16).padStart(2, "0");

  return `#${r}${g}${b}`;
}
