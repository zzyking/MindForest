/**
 * Forest graph assembly + live d3-force layout.
 *
 * The forest is a *live system*, Obsidian-style: ForestView owns one
 * `ForestLayout` for its whole mount — a graphology graph, a d3-force
 * simulation, and the simulation's node/link arrays — and `useSimLoop`
 * ticks the simulation on rAF, writing positions into the graph each
 * frame (sigma repaints reactively off graphology events). Structure
 * changes never rebuild anything: `syncForestStructure` diffs the
 * store snapshot into the existing graph + simulation and the caller
 * reheats — new nodes glide in from beside their parent instead of the
 * whole constellation re-settling.
 *
 * Cold positions come from a radial tidy-tree seed (planar for tree
 * edges — see radialTreeSeed) so the first relax animates an "unfold"
 * instead of untangling random noise.
 *
 * The crossing-count harness (web/scripts/layout-crossings.mts) drives
 * this same code through the synchronous `buildForestGraph` wrapper —
 * re-run it whenever the forces or the seeding change.
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceLink,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import Graph from "graphology";

import {
  chargeScale,
  layoutBeta,
  treeAnchorStrength,
  treeSnapBlend,
} from "./layoutContinuum";
import { palette } from "./palette";
import type { NodeId, NodeType, TopicDetail, TopicId, TopicSummary } from "@/lib/types";

export type EdgeKind = "tree" | "link" | "xlink";

export interface SimNode extends SimulationNodeDatum {
  id: NodeId;
  topicId: TopicId;
  type: NodeType;
  title: string;
  degree: number;
}

export interface SimLink extends SimulationLinkDatum<SimNode> {
  source: NodeId | SimNode;
  target: NodeId | SimNode;
  kind: EdgeKind;
}

/** Static per-topic info for the floating labels. Positions are
 *  computed live per frame via computeTopicAnchorPoints — with a
 *  running simulation there is no "settled centroid" to bake. */
export interface TopicAnchorInfo {
  topicId: TopicId;
  title: string;
  nodeCount: number;
}

/**
 * The live layout owned by ForestView for its whole mount. `graph` and
 * `sim` keep their identity across structure syncs; `simNodes` /
 * `nodeById` / `neighbors` / `anchors` are replaced or mutated by
 * syncForestStructure.
 *
 * L3: `treeTargets` are hierarchy positions (radial seed + topic orbit)
 * used as soft anchors when μ is near; `parentById` / `childrenById`
 * feed family-scope dimming.
 */
export interface ForestLayout {
  graph: Graph;
  sim: Simulation<SimNode, SimLink>;
  linkForce: ForceLink<SimNode, SimLink>;
  simNodes: SimNode[];
  nodeById: Map<NodeId, SimNode>;
  neighbors: Map<NodeId, Set<NodeId>>;
  anchors: TopicAnchorInfo[];
  /** Absolute graph coords for the hierarchy field (L3 continuum). */
  treeTargets: Map<NodeId, { x: number; y: number }>;
  parentById: Map<NodeId, NodeId | null>;
  childrenById: Map<NodeId, NodeId[]>;
  /** Last applied layout β — skip force rebind when unchanged. */
  lastLayoutBeta: number;
}

export interface SyncResult {
  /** False when no topic detail has hydrated yet — nothing to show. */
  hasReadyData: boolean;
  /** True when this sync populated an empty layout. */
  isCreation: boolean;
  added: number;
  removed: number;
  edgesChanged: boolean;
  /** Creation only: fraction of nodes seeded from prevPositions. */
  warmFraction: number;
}

/** Seedable PRNG so HMR doesn't reshuffle the layout on each tick. */
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ring spacing of the radial seed — a touch over the simulation's
 *  linkDistance (36) so the relax pass pulls inward rather than pushing
 *  branches outward through each other. */
const RING = 40;

const nodeRadius = (n: SimNode) => 6 + 1.5 * Math.sqrt(n.degree);

interface RadialSeed {
  positions: Map<NodeId, { x: number; y: number }>;
  /** Outer radius of the seeded disc (for topic-center spacing). */
  radius: number;
}

/**
 * Radial tidy-tree seed for one topic's parent-edge tree, centred on
 * (0,0). Every subtree gets an angular wedge proportional to its leaf
 * count; a node sits at `depth × RING` along the bisector of its
 * wedge. By construction the tree edges of this embedding never cross
 * — and d3-force started from a planar embedding mostly just relaxes
 * distances instead of inventing a new (tangled) equilibrium, which is
 * what kills the edge crossings random-disc seeding used to produce.
 * Cross-`links` may still cross tree edges; the graph including them
 * isn't planar in general, and they render as curves anyway.
 */
function radialTreeSeed(detail: TopicDetail): RadialSeed {
  const ids = new Set(detail.nodes.map((n) => n.id));
  const children = new Map<NodeId, NodeId[]>();
  const roots: NodeId[] = [];
  // ULID sort = creation order; keeps sibling wedge order deterministic.
  const sorted = [...detail.nodes].sort((a, b) => a.id.localeCompare(b.id));
  for (const n of sorted) {
    if (n.parent && ids.has(n.parent)) {
      const arr = children.get(n.parent) ?? [];
      arr.push(n.id);
      children.set(n.parent, arr);
    } else {
      roots.push(n.id);
    }
  }

  // Subtree leaf counts, iterative post-order (no recursion: depth is
  // user-controlled).
  const leaves = new Map<NodeId, number>();
  for (const root of roots) {
    const stack: [NodeId, boolean][] = [[root, false]];
    const seen = new Set<NodeId>();
    while (stack.length > 0) {
      const [id, processed] = stack.pop()!;
      const kids = children.get(id) ?? [];
      if (processed || kids.length === 0) {
        leaves.set(
          id,
          kids.length === 0 ? 1 : kids.reduce((s, k) => s + (leaves.get(k) ?? 1), 0),
        );
      } else {
        if (seen.has(id)) continue; // corrupt-data cycle guard
        seen.add(id);
        stack.push([id, true]);
        for (const k of kids) stack.push([k, false]);
      }
    }
  }

  // BFS wedge assignment. Siblings keep ULID (= creation) order — a
  // barycenter reorder that pulls link-partner subtrees adjacent was
  // prototyped here and measured *flat to slightly worse* on synthetic
  // forests (deep-node chords sweep intermediate subtrees regardless of
  // sibling order), so it was dropped for simplicity.
  const positions = new Map<NodeId, { x: number; y: number }>();
  let maxDepth = 0;
  const totalLeaves = roots.reduce((s, r) => s + (leaves.get(r) ?? 1), 0) || 1;
  // Multiple roots only happen on orphaned nodes (parent missing from
  // the snapshot) — push them to depth 1 so they don't stack at origin.
  const rootDepth = roots.length > 1 ? 1 : 0;
  const queue: { id: NodeId; depth: number; a0: number; a1: number }[] = [];
  let cursor = 0;
  for (const r of roots) {
    const span = ((leaves.get(r) ?? 1) / totalLeaves) * Math.PI * 2;
    queue.push({ id: r, depth: rootDepth, a0: cursor, a1: cursor + span });
    cursor += span;
  }
  while (queue.length > 0) {
    const { id, depth, a0, a1 } = queue.shift()!;
    const mid = (a0 + a1) / 2;
    const r = depth * RING;
    positions.set(id, { x: Math.cos(mid) * r, y: Math.sin(mid) * r });
    if (depth > maxDepth) maxDepth = depth;
    const kids = children.get(id) ?? [];
    const kidLeaves = kids.reduce((s, k) => s + (leaves.get(k) ?? 1), 0) || 1;
    let ca = a0;
    for (const k of kids) {
      if (positions.has(k)) continue;
      const span = ((leaves.get(k) ?? 1) / kidLeaves) * (a1 - a0);
      queue.push({ id: k, depth: depth + 1, a0: ca, a1: ca + span });
      ca += span;
    }
  }
  return { positions, radius: Math.max(RING, maxDepth * RING) };
}

/**
 * Layout-relevant signature of the store snapshots. Two snapshots with
 * the same key produce the same graph *structure* (node set, tree
 * edges, link edges) — node titles and types deliberately excluded
 * because they only affect labels/colors, which ForestView syncs into
 * the live graph in place. Topic titles are included (they feed the
 * floating anchors, and renames are rare enough that a resync is
 * fine).
 *
 * Used to gate `syncForestStructure` so that per-keystroke summary
 * syncs and hydration-order identity churn don't trigger graph diffs.
 */
export function forestLayoutKey(
  topics: Record<TopicId, TopicSummary>,
  topicDetails: Record<TopicId, TopicDetail>,
): string {
  const parts: string[] = [];
  for (const id of (Object.keys(topics) as TopicId[]).sort()) {
    const d = topicDetails[id];
    if (!d) {
      parts.push(`${id}:pending`);
      continue;
    }
    parts.push(`${id}:${d.title}`);
    // Sort defensively — the wire order is stable today, but the key
    // must not depend on it.
    const nodes = [...d.nodes].sort((a, b) => a.id.localeCompare(b.id));
    for (const n of nodes) {
      parts.push(`${n.id}<${n.parent ?? ""}[${[...n.links].sort().join(",")}]`);
    }
  }
  return parts.join("|");
}

/**
 * Fresh, empty live layout. Forces are configured once here; the alpha
 * starts at 0 (asleep) — callers reheat after syncing structure in.
 * Parameters tuned against the crossing harness:
 *   charge -120 / center 0.3 / tree links 36px @ 0.7 /
 *   reference links 64px @ 0.25 (anything stronger folds unrelated
 *   branches through each other) / collide for spacing.
 */
export function createForestLayout(): ForestLayout {
  const graph = new Graph({ multi: false, type: "undirected", allowSelfLoops: false });
  const linkForce = forceLink<SimNode, SimLink>([])
    .id((n) => n.id)
    .distance((l) => (l.kind === "tree" ? 36 : 64))
    .strength((l) => (l.kind === "tree" ? 0.7 : l.kind === "link" ? 0.25 : 0.2));
  const sim = forceSimulation<SimNode>([])
    .force("charge", forceManyBody().strength(-120))
    .force("center", forceCenter(0, 0).strength(0.3))
    .force("x", forceX(0).strength(0.04)) // Pull disconnected topics closer
    .force("y", forceY(0).strength(0.04)) // Pull disconnected topics closer
    // L3: per-node hierarchy anchors (strength modulated by μ).
    .force(
      "treeX",
      forceX<SimNode>((n) => layoutTreeX(n)).strength(0),
    )
    .force(
      "treeY",
      forceY<SimNode>((n) => layoutTreeY(n)).strength(0),
    )
    .force("link", linkForce)
    .force("collide", forceCollide<SimNode>((n) => nodeRadius(n) * 1.6).iterations(3))
    .stop(); // we drive ticks manually (useSimLoop / buildForestGraph)
  sim.alpha(0);
  return {
    graph,
    sim,
    linkForce,
    simNodes: [],
    nodeById: new Map(),
    neighbors: new Map(),
    anchors: [],
    treeTargets: new Map(),
    parentById: new Map(),
    childrenById: new Map(),
    lastLayoutBeta: 1,
  };
}

// Module-level target lookup so forceX/Y accessors stay stable closures
// re-bound via applyContinuumForces (they close over layout.treeTargets).
let continuumTargets: Map<NodeId, { x: number; y: number }> = new Map();

function layoutTreeX(n: SimNode): number {
  return continuumTargets.get(n.id)?.x ?? n.x ?? 0;
}
function layoutTreeY(n: SimNode): number {
  return continuumTargets.get(n.id)?.y ?? n.y ?? 0;
}

/**
 * Diff the store snapshot into the live layout: add/remove graph nodes
 * and edges in place, position newcomers, rebind the simulation arrays.
 * Does NOT tick or reheat — the caller decides how much energy the
 * change deserves (cold unfold vs. folding a few nodes in).
 *
 * New-node placement priority:
 *   1. `prevPositions` (cross-mount warm start, creation only),
 *   2. the topic's radial tidy-tree seed (creation, or a whole new
 *      topic appearing mid-session — placed beyond the current bbox),
 *   3. beside the parent's current position (multi-pass, so an agent
 *      batch adding a whole subtree chains correctly),
 *   4. the topic centroid (orphans).
 */
export function syncForestStructure(
  layout: ForestLayout,
  topics: Record<TopicId, TopicSummary>,
  topicDetails: Record<TopicId, TopicDetail>,
  prevPositions?: ReadonlyMap<NodeId, { x: number; y: number }>,
): SyncResult {
  const t0 = performance.now();
  const ready: TopicDetail[] = (Object.keys(topics) as TopicId[])
    .sort()
    .map((id) => topicDetails[id])
    .filter((d): d is TopicDetail => Boolean(d));
  const isCreation = layout.simNodes.length === 0;
  if (ready.length === 0) {
    return { hasReadyData: false, isCreation, added: 0, removed: 0, edgesChanged: false, warmFraction: 0 };
  }
  const { graph } = layout;

  // ── Desired structure ─────────────────────────────────────────────
  interface DesiredNode {
    topicId: TopicId;
    type: NodeType;
    title: string;
    parent: NodeId | null;
  }
  const desiredNodes = new Map<NodeId, DesiredNode>();
  for (const detail of ready) {
    for (const n of detail.nodes) {
      desiredNodes.set(n.id, {
        topicId: detail.id,
        type: n.type,
        title: n.title || "Untitled",
        parent: n.parent,
      });
    }
  }
  const pairKey = (a: NodeId, b: NodeId) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const desiredEdges = new Map<string, { a: NodeId; b: NodeId; kind: EdgeKind }>();
  const adjacency = new Map<NodeId, Set<NodeId>>();
  const addAdj = (a: NodeId, b: NodeId) => {
    let ax = adjacency.get(a);
    if (!ax) adjacency.set(a, (ax = new Set()));
    ax.add(b);
    let bx = adjacency.get(b);
    if (!bx) adjacency.set(b, (bx = new Set()));
    bx.add(a);
  };
  // Tree edges first so a parent edge wins over a duplicate reference
  // link on the same pair.
  for (const detail of ready) {
    for (const n of detail.nodes) {
      if (!n.parent || !desiredNodes.has(n.parent)) continue;
      desiredEdges.set(pairKey(n.id, n.parent), { a: n.parent, b: n.id, kind: "tree" });
      addAdj(n.id, n.parent);
    }
  }
  for (const detail of ready) {
    for (const n of detail.nodes) {
      for (const dst of n.links) {
        const other = desiredNodes.get(dst);
        if (!other || dst === n.id) continue;
        const key = pairKey(n.id, dst);
        if (desiredEdges.has(key)) continue;
        desiredEdges.set(key, {
          a: n.id,
          b: dst,
          kind: other.topicId === detail.id ? "link" : "xlink",
        });
        addAdj(n.id, dst);
      }
    }
  }

  // ── Removals ──────────────────────────────────────────────────────
  let removed = 0;
  for (const id of [...layout.nodeById.keys()]) {
    if (desiredNodes.has(id)) continue;
    graph.dropNode(id); // drops incident edges too
    layout.nodeById.delete(id);
    removed += 1;
  }
  if (removed > 0) {
    layout.simNodes = layout.simNodes.filter((n) => layout.nodeById.has(n.id));
  }

  // ── Additions ─────────────────────────────────────────────────────
  const rand = mulberry32(0xc0ffee);
  // Topics needing a fresh radial seed: at creation all of them (on a
  // non-overlapping orbit); incrementally only topics with no existing
  // nodes (lined up beyond the current bounding box).
  const seedsByTopic = new Map<
    TopicId,
    { positions: Map<NodeId, { x: number; y: number }>; cx: number; cy: number }
  >();
  if (isCreation) {
    const seeds = ready.map(radialTreeSeed);
    const N = ready.length;
    const maxR = Math.max(...seeds.map((s) => s.radius)) + 30;
    // Adjacent-centre distance on the orbit ≈ 2·orbit·sin(π/N) — keep
    // it ≥ two disc radii so seed discs can't interleave.
    const orbit = N === 1 ? 0 : Math.max(60, maxR / Math.sin(Math.PI / N));
    for (let i = 0; i < N; i++) {
      const theta = N === 1 ? 0 : (2 * Math.PI * i) / N - Math.PI / 2;
      seedsByTopic.set(ready[i]!.id, {
        positions: seeds[i]!.positions,
        cx: Math.cos(theta) * orbit,
        cy: Math.sin(theta) * orbit,
      });
    }
  } else {
    let maxX = -Infinity;
    let sumY = 0;
    let count = 0;
    for (const n of layout.simNodes) {
      const x = n.x ?? 0;
      if (x > maxX) maxX = x;
      sumY += n.y ?? 0;
      count += 1;
    }
    let offsetX = count > 0 ? maxX : 0;
    for (const detail of ready) {
      if (detail.nodes.some((n) => layout.nodeById.has(n.id))) continue;
      const seed = radialTreeSeed(detail);
      offsetX += seed.radius + 80;
      seedsByTopic.set(detail.id, {
        positions: seed.positions,
        cx: offsetX,
        cy: count > 0 ? sumY / count : 0,
      });
      offsetX += seed.radius;
    }
  }

  let added = 0;
  let warmCount = 0;
  const addNodeAt = (id: NodeId, info: DesiredNode, x: number, y: number) => {
    const node: SimNode = {
      id,
      topicId: info.topicId,
      type: info.type,
      title: info.title,
      degree: 0,
      x,
      y,
    };
    layout.simNodes.push(node);
    layout.nodeById.set(id, node);
    graph.addNode(id, {
      x,
      y,
      size: nodeRadius(node),
      label: info.title,
      color: palette().types[info.type],
      topicId: info.topicId,
      nodeType: info.type,
      degree: 0,
    });
    added += 1;
  };

  // Phase 1: previous position or topic seed.
  const pending: NodeId[] = [];
  for (const [id, info] of desiredNodes) {
    if (layout.nodeById.has(id)) continue;
    const prev = prevPositions?.get(id);
    if (prev) {
      warmCount += 1;
      addNodeAt(id, info, prev.x, prev.y);
      continue;
    }
    const seed = seedsByTopic.get(info.topicId);
    const p = seed?.positions.get(id);
    if (seed && p) {
      // ±2px jitter breaks the perfect symmetry of e.g. star graphs,
      // which can deadlock the charge force.
      addNodeAt(id, info, seed.cx + p.x + (rand() - 0.5) * 4, seed.cy + p.y + (rand() - 0.5) * 4);
      continue;
    }
    pending.push(id);
  }
  // Phase 2: beside the parent. Multi-pass so freshly-placed parents
  // can host their own new children in the same sync.
  let progress = true;
  while (progress && pending.length > 0) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const id = pending[i]!;
      const info = desiredNodes.get(id)!;
      const parent = info.parent ? layout.nodeById.get(info.parent) : undefined;
      if (!parent) continue;
      const ang = rand() * Math.PI * 2;
      addNodeAt(id, info, (parent.x ?? 0) + Math.cos(ang) * 14, (parent.y ?? 0) + Math.sin(ang) * 14);
      pending.splice(i, 1);
      progress = true;
    }
  }
  // Phase 3: orphans land at their topic's current centroid.
  for (const id of pending) {
    const info = desiredNodes.get(id)!;
    let sx = 0;
    let sy = 0;
    let c = 0;
    for (const n of layout.simNodes) {
      if (n.topicId !== info.topicId) continue;
      sx += n.x ?? 0;
      sy += n.y ?? 0;
      c += 1;
    }
    const ang = rand() * Math.PI * 2;
    addNodeAt(
      id,
      info,
      (c > 0 ? sx / c : 0) + Math.cos(ang) * 30,
      (c > 0 ? sy / c : 0) + Math.sin(ang) * 30,
    );
  }

  // ── Edge diff ─────────────────────────────────────────────────────
  let edgesChanged = false;
  const dropKeys: string[] = [];
  graph.forEachEdge((edgeKey, attrs, s, t) => {
    const want = desiredEdges.get(pairKey(s as NodeId, t as NodeId));
    // Kind changes (e.g. reparent turning a link pair into a tree pair)
    // are handled as drop + re-add so render attrs stay consistent.
    if (!want || want.kind !== (attrs.kind as EdgeKind)) dropKeys.push(edgeKey);
  });
  for (const k of dropKeys) graph.dropEdge(k);
  edgesChanged = dropKeys.length > 0;
  for (const { a, b, kind } of desiredEdges.values()) {
    if (graph.hasEdge(a, b)) continue;
    graph.addEdgeWithKey(`${kind}:${a}->${b}`, a, b, {
      // Curve every non-tree edge: reference edges read as an overlay
      // layer arcing over the tree, so their (unavoidable) crossings
      // stop registering as layout noise.
      type: kind === "tree" ? "line" : "curve",
      size: kind === "tree" ? 1 : 1.4,
      color:
        kind === "tree" ? palette().dim : kind === "link" ? palette().accent : palette().accentDeep,
      kind,
    });
    edgesChanged = true;
  }

  // ── Degrees + sizes ───────────────────────────────────────────────
  for (const n of layout.simNodes) {
    const d = adjacency.get(n.id)?.size ?? 0;
    if (n.degree !== d) {
      n.degree = d;
      graph.mergeNodeAttributes(n.id, { degree: d, size: nodeRadius(n) });
    }
  }

  // ── L3 hierarchy field (tree targets + parent/children) ───────────
  // Always rebuild absolute radial targets so near-μ anchors stay valid
  // even after incremental structure changes. Topic orbit placement
  // matches cold creation when possible; otherwise uses live centroids.
  rebuildTreeTargets(layout, ready, seedsByTopic, isCreation);

  const parentById = new Map<NodeId, NodeId | null>();
  const childrenById = new Map<NodeId, NodeId[]>();
  for (const [id, info] of desiredNodes) {
    parentById.set(id, info.parent);
    if (info.parent) {
      const arr = childrenById.get(info.parent) ?? [];
      arr.push(id);
      childrenById.set(info.parent, arr);
    }
  }
  layout.parentById = parentById;
  layout.childrenById = childrenById;

  // ── Rebind the simulation ─────────────────────────────────────────
  // nodes() re-initializes every force with the new array; links()
  // must come after so the link force resolves ids against it.
  layout.sim.nodes(layout.simNodes);
  layout.linkForce.links(
    [...desiredEdges.values()].map(({ a, b, kind }) => ({ source: a, target: b, kind })),
  );
  // Re-apply continuum forces after nodes() (which re-inits forces).
  applyContinuumForces(layout, layout.lastLayoutBeta);

  layout.neighbors = adjacency;
  layout.anchors = ready.map((d) => ({
    topicId: d.id,
    title: d.title,
    nodeCount: d.nodes.length,
  }));

  console.info(
    `[forest] structure sync ${(performance.now() - t0).toFixed(1)}ms (${
      isCreation ? "creation" : "incremental"
    }) · +${added} −${removed} nodes · ${graph.size} edges`,
  );
  return {
    hasReadyData: true,
    isCreation,
    added,
    removed,
    edgesChanged,
    warmFraction: desiredNodes.size > 0 ? warmCount / desiredNodes.size : 0,
  };
}

/**
 * Rebuild absolute hierarchy targets for every node. Uses the same
 * radial seed + topic orbit as cold placement so near-μ layout reads
 * as a tidy tree, not a random force cloud.
 */
function rebuildTreeTargets(
  layout: ForestLayout,
  ready: TopicDetail[],
  seedsByTopic: Map<
    TopicId,
    { positions: Map<NodeId, { x: number; y: number }>; cx: number; cy: number }
  >,
  isCreation: boolean,
): void {
  const targets = new Map<NodeId, { x: number; y: number }>();

  // Prefer seeds already computed this sync (creation / new topics).
  // For existing topics, recompute radial seed and place at the live
  // topic centroid so the tree field tracks the force cluster.
  for (const detail of ready) {
    const existing = seedsByTopic.get(detail.id);
    let cx: number;
    let cy: number;
    let positions: Map<NodeId, { x: number; y: number }>;
    if (existing) {
      cx = existing.cx;
      cy = existing.cy;
      positions = existing.positions;
    } else {
      const seed = radialTreeSeed(detail);
      positions = seed.positions;
      // Live centroid of this topic's sim nodes (fallback 0,0).
      let sx = 0;
      let sy = 0;
      let c = 0;
      for (const n of layout.simNodes) {
        if (n.topicId !== detail.id) continue;
        sx += n.x ?? 0;
        sy += n.y ?? 0;
        c += 1;
      }
      if (c > 0) {
        cx = sx / c;
        cy = sy / c;
      } else if (isCreation) {
        cx = 0;
        cy = 0;
      } else {
        cx = 0;
        cy = 0;
      }
    }
    for (const [id, p] of positions) {
      targets.set(id, { x: cx + p.x, y: cy + p.y });
    }
  }
  layout.treeTargets = targets;
  continuumTargets = targets;
}

/**
 * L3: rebind force strengths from layout β (μ-driven). Safe to call
 * every μ change; cheap when β is unchanged (caller may still reheat).
 */
export function applyContinuumForces(layout: ForestLayout, beta: number): void {
  continuumTargets = layout.treeTargets;
  const b = Math.min(1, Math.max(0, beta));
  layout.lastLayoutBeta = b;

  const anchor = treeAnchorStrength(b);
  const charge = -120 * chargeScale(b);
  // Far: keep weak global pull; near: let tree anchors own structure.
  const globalXY = 0.04 * b;
  const centerStr = 0.05 + 0.25 * b;

  const { sim } = layout;
  const chargeForce = sim.force("charge") as { strength: (s: number) => unknown } | undefined;
  chargeForce?.strength(charge);
  const centerForce = sim.force("center") as { strength: (s: number) => unknown } | undefined;
  centerForce?.strength(centerStr);
  const xForce = sim.force("x") as { strength: (s: number) => unknown } | undefined;
  xForce?.strength(globalXY);
  const yForce = sim.force("y") as { strength: (s: number) => unknown } | undefined;
  yForce?.strength(globalXY);

  // Tree anchors: forceX/Y with per-node accessors (already bound).
  const treeX = sim.force("treeX") as { strength: (s: number) => unknown } | undefined;
  const treeY = sim.force("treeY") as { strength: (s: number) => unknown } | undefined;
  treeX?.strength(anchor);
  treeY?.strength(anchor);

  // Link strength: stronger tree links when near; full when far.
  const linkBoost = 0.55 + 0.45 * b; // near slightly softer tree pull via anchors
  layout.linkForce.strength((l) => {
    const base = l.kind === "tree" ? 0.7 : l.kind === "link" ? 0.25 : 0.2;
    // Near: weaken non-tree links so hierarchy dominates.
    if (l.kind !== "tree") return base * b;
    return base * linkBoost;
  });
}

/**
 * Apply continuum from user μ. Returns whether forces changed enough
 * to warrant a reheat.
 */
export function setLayoutFromMu(layout: ForestLayout, mu: number): boolean {
  const beta = layoutBeta(mu);
  const prev = layout.lastLayoutBeta;
  applyContinuumForces(layout, beta);
  return Math.abs(beta - prev) > 0.02;
}

/** After a sim tick: soft-snap toward tree targets when nearly near-locked. */
export function applyTreeSnap(layout: ForestLayout): void {
  const snap = treeSnapBlend(layout.lastLayoutBeta);
  if (snap < 0.01) return;
  for (const n of layout.simNodes) {
    const t = layout.treeTargets.get(n.id);
    if (!t) continue;
    const x = n.x ?? t.x;
    const y = n.y ?? t.y;
    n.x = x + (t.x - x) * snap;
    n.y = y + (t.y - y) * snap;
    if (snap > 0.85) {
      n.vx = 0;
      n.vy = 0;
    }
  }
}

/** Copy the simulation's positions into the graphology graph in one
 *  batched update — a single graphology event, which sigma coalesces
 *  into one repaint. Called once per simulation tick. */
export function writeSimPositionsToGraph(layout: ForestLayout): void {
  applyTreeSnap(layout);
  layout.graph.updateEachNodeAttributes(
    (id, attrs) => {
      const sn = layout.nodeById.get(id as NodeId);
      if (sn) {
        attrs.x = sn.x ?? (attrs.x as number);
        attrs.y = sn.y ?? (attrs.y as number);
      }
      return attrs;
    },
    { attributes: ["x", "y"] },
  );
}

/**
 * Run the simulation to rest from its current (seed) positions, capture
 * the settled positions, then restore the nodes to exactly where they
 * started. Used on a COLD mount to learn the resting *scale* of the
 * constellation without disturbing it: the camera frames these settled
 * positions so the cold view opens at the same size it will rest at —
 * matching a warm switch-back, which fits already-settled positions —
 * while the live bloom still animates outward from the compact seed.
 *
 * Mirrors buildForestGraph's cold settle (alpha 0.6, tick to cool); the
 * loop stops at convergence, capped so corrupt data can't spin forever.
 */
export function presettleForFit(layout: ForestLayout): Map<NodeId, { x: number; y: number }> {
  const { sim, simNodes } = layout;
  const seed = simNodes.map((n) => ({ n, x: n.x ?? 0, y: n.y ?? 0 }));
  sim.alpha(0.6);
  for (let i = 0; i < 400 && sim.alpha() > sim.alphaMin(); i++) sim.tick();
  const rest = new Map<NodeId, { x: number; y: number }>();
  for (const n of simNodes) rest.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
  // Snap every node back to its seed with zero velocity so the upcoming
  // reheat blooms from a crisp rest, not from leftover settle momentum.
  for (const s of seed) {
    s.n.x = s.x;
    s.n.y = s.y;
    s.n.vx = 0;
    s.n.vy = 0;
  }
  sim.alpha(0); // reheat() raises-never-lowers, so leave it cold
  return rest;
}

/** Live per-topic anchor points for the floating labels: centroid X,
 *  cluster top + headroom. O(nodes); cheap enough to run per frame
 *  while the simulation is hot. */
export function computeTopicAnchorPoints(graph: Graph): Map<TopicId, { x: number; y: number }> {
  const acc = new Map<TopicId, { sumX: number; maxY: number; count: number }>();
  graph.forEachNode((_id, attrs) => {
    const topicId = attrs.topicId as TopicId;
    const x = attrs.x as number;
    const y = attrs.y as number;
    const a = acc.get(topicId);
    if (a) {
      a.sumX += x;
      a.count += 1;
      if (y > a.maxY) a.maxY = y;
    } else {
      acc.set(topicId, { sumX: x, maxY: y, count: 1 });
    }
  });
  const out = new Map<TopicId, { x: number; y: number }>();
  for (const [topicId, a] of acc) {
    out.set(topicId, { x: a.sumX / a.count, y: a.maxY + 60 });
  }
  return out;
}

export interface ForestGraphData {
  graph: Graph | null;
  anchors: TopicAnchorInfo[];
  neighbors: Map<NodeId, Set<NodeId>>;
  hasNoData: boolean;
}

/**
 * Synchronous one-shot layout: create → sync → settle. The app uses
 * the live path (createForestLayout + syncForestStructure + useSimLoop)
 * — this wrapper exists for the crossing harness and other headless
 * callers that want baked positions. Warm/cold tick counts mirror what
 * the live loop converges to.
 */
export function buildForestGraph(
  topics: Record<TopicId, TopicSummary>,
  topicDetails: Record<TopicId, TopicDetail>,
  prevPositions?: ReadonlyMap<NodeId, { x: number; y: number }>,
): ForestGraphData {
  const layout = createForestLayout();
  const res = syncForestStructure(layout, topics, topicDetails, prevPositions);
  if (!res.hasReadyData) {
    return {
      graph: null,
      anchors: [],
      neighbors: new Map(),
      hasNoData: Object.keys(topics).length === 0,
    };
  }
  const warm = res.warmFraction >= 0.7;
  // Both start below d3's default alpha=1: the seed (radial tree or
  // previous positions) is already near the equilibrium we want, and a
  // full-energy run tears the planar embedding apart before it cools.
  // 0.6 cold won the (alpha × link-strength) sweep in the harness.
  layout.sim.alpha(warm ? 0.3 : 0.6);
  const ticks = warm ? 100 : 300;
  for (let i = 0; i < ticks; i++) layout.sim.tick();
  writeSimPositionsToGraph(layout);
  return {
    graph: layout.graph,
    anchors: layout.anchors,
    neighbors: layout.neighbors,
    hasNoData: false,
  };
}
