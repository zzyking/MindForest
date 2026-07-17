/**
 * L3 layout continuum — pure maps from user-owned μ to layout blend +
 * scope band. Positions are driven by graphBuild tree anchors + force
 * (see applyContinuumForces); this module stays free of d3/sigma.
 *
 * β_layout: 0 = hierarchy-locked (near), 1 = pure force graph (far).
 * Scope: family → topic → vault as μ rises (visibility / dimming).
 */

import type { NodeId, TopicId } from "@/lib/types";

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Layout blend ∈ [0,1]. Near band (μ ≲ 0.25) stays tree-locked;
 * outer band (μ ≳ 0.85) is pure force. Continuous in between so the
 * wheel/slider never snaps layout modes.
 */
export function layoutBeta(mu: number): number {
  return smoothstep(0.25, 0.85, clamp01(mu));
}

export type ScopeBand = "family" | "topic" | "vault";

/** Visibility scope for dimming out-of-band nodes (not graph membership). */
export function scopeBand(mu: number): ScopeBand {
  const v = clamp01(mu);
  if (v < 0.35) return "family";
  if (v < 0.7) return "topic";
  return "vault";
}

/**
 * Strength of the tree-anchor force. High near (β low), off at far.
 * Multiplied into d3 force alpha each tick.
 */
export function treeAnchorStrength(beta: number): number {
  // (1−β)² so mid continuum still mostly force-relaxed.
  const w = 1 - clamp01(beta);
  return 0.35 * w * w;
}

/**
 * Charge multiplier: soft near (tree holds structure), full far.
 */
export function chargeScale(beta: number): number {
  return 0.15 + 0.85 * clamp01(beta);
}

/**
 * After-tick soft snap toward tree targets when nearly hierarchy-locked
 * (β ≈ 0). Keeps near band from melting under residual charge.
 */
export function treeSnapBlend(beta: number): number {
  // 1 = fully snap to tree; 0 = trust force only.
  return Math.max(0, 1 - clamp01(beta) / 0.12);
}

/** Focus family: self + ancestors + descendants + siblings (same parent). */
export function computeFamilySet(
  focusId: NodeId,
  parentById: ReadonlyMap<NodeId, NodeId | null>,
  childrenById: ReadonlyMap<NodeId, readonly NodeId[]>,
): Set<NodeId> {
  const out = new Set<NodeId>();
  if (!parentById.has(focusId) && !childrenById.has(focusId)) {
    // Unknown focus — empty means "don't dim" caller-side.
    return out;
  }
  out.add(focusId);
  // Ancestors
  let cursor: NodeId | null | undefined = parentById.get(focusId) ?? null;
  const seen = new Set<NodeId>();
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    out.add(cursor);
    cursor = parentById.get(cursor) ?? null;
  }
  // Descendants (BFS)
  const q: NodeId[] = [focusId];
  while (q.length > 0) {
    const id = q.shift()!;
    for (const c of childrenById.get(id) ?? []) {
      if (out.has(c)) continue;
      out.add(c);
      q.push(c);
    }
  }
  // Siblings
  const parent = parentById.get(focusId) ?? null;
  if (parent) {
    for (const s of childrenById.get(parent) ?? []) out.add(s);
  }
  return out;
}

export function nodeInScope(
  nodeId: NodeId,
  topicId: TopicId,
  band: ScopeBand,
  focusId: NodeId | null,
  focusTopicId: TopicId | null,
  family: ReadonlySet<NodeId>,
): boolean {
  if (band === "vault") return true;
  if (!focusId || !focusTopicId) return true;
  if (band === "topic") return topicId === focusTopicId;
  // family
  if (family.size === 0) return topicId === focusTopicId;
  return family.has(nodeId);
}
