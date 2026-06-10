/**
 * Forest graph assembly — pure data work, no React and no sigma.
 *
 * Takes the store's topic summaries + details and produces:
 *   - a settled graphology graph (d3-force layout baked into x/y),
 *   - per-topic anchors (centroid + bbox top) for the floating labels,
 *   - a neighbour adjacency map for the hover reducer.
 *
 * d3-force runs synchronously for a fixed 300 ticks — enough for the
 * layout to visually settle on graphs up to ~500 nodes. Callers should
 * treat a build as expensive (tens of ms) and memoize on inputs.
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import Graph from "graphology";

import { palette } from "./palette";
import type { NodeId, NodeType, TopicDetail, TopicId, TopicSummary } from "@/lib/types";

interface SimNode extends SimulationNodeDatum {
  id: NodeId;
  topicId: TopicId;
  type: NodeType;
  title: string;
  degree: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: NodeId | SimNode;
  target: NodeId | SimNode;
  /** "tree" | "link" (same-topic) | "xlink" (cross-topic). */
  kind: "tree" | "link" | "xlink";
}

export interface TopicAnchor {
  topicId: TopicId;
  title: string;
  centerX: number;
  centerY: number;
  topY: number;
  nodeCount: number;
}

export interface ForestGraphData {
  graph: Graph | null;
  anchors: TopicAnchor[];
  neighbors: Map<NodeId, Set<NodeId>>;
  hasNoData: boolean;
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

/**
 * Layout-relevant signature of the store snapshots. Two snapshots with
 * the same key produce the same graph *structure* (node set, tree
 * edges, link edges) — node titles and types deliberately excluded
 * because they only affect labels/colors, which ForestView syncs into
 * the live graph in place. Topic titles are included (they feed the
 * floating anchors, and renames are rare enough that a rebuild is
 * fine).
 *
 * Used to gate `buildForestGraph` so that per-keystroke summary syncs
 * and hydration-order identity churn don't trigger relayouts.
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

export function buildForestGraph(
  topics: Record<TopicId, TopicSummary>,
  topicDetails: Record<TopicId, TopicDetail>,
  /** Positions from the previous layout. When most nodes are covered,
   *  the simulation warm-starts from them (fewer ticks, lower alpha) so
   *  consecutive layouts stay visually continuous instead of finding a
   *  fresh equilibrium that shuffles the whole constellation. */
  prevPositions?: ReadonlyMap<NodeId, { x: number; y: number }>,
): ForestGraphData {
  const buildStart = performance.now();
  const ready: TopicDetail[] = (Object.keys(topics) as TopicId[])
    .sort()
    .map((id) => topicDetails[id])
    .filter((d): d is TopicDetail => Boolean(d));

  if (ready.length === 0) {
    return {
      graph: null,
      anchors: [],
      neighbors: new Map<NodeId, Set<NodeId>>(),
      hasNoData: Object.keys(topics).length === 0,
    };
  }

  // Pass 1: build the simulation node + link lists. d3-force mutates
  // these in place (assigns x/y), so we read the positions back
  // after settling.
  const simNodes: SimNode[] = [];
  const simLinks: SimLink[] = [];
  const nodeById = new Map<NodeId, SimNode>();
  const adjacency = new Map<NodeId, Set<NodeId>>();
  const addEdge = (a: NodeId, b: NodeId) => {
    let ax = adjacency.get(a);
    if (!ax) {
      ax = new Set();
      adjacency.set(a, ax);
    }
    ax.add(b);
    let bx = adjacency.get(b);
    if (!bx) {
      bx = new Set();
      adjacency.set(b, bx);
    }
    bx.add(a);
  };

  // Seed initial positions so d3-force converges quickly + stably:
  // each topic gets an angular slice on a unit circle, nodes randomly
  // placed inside its slice's disc.
  const N = ready.length;
  const SEED_RADIUS = 80;
  const ORBIT_R = 20;
  const rand = mulberry32(0xc0ffee);
  let warmCount = 0;
  for (let i = 0; i < ready.length; i++) {
    const detail = ready[i]!;
    const theta = N === 1 ? 0 : (2 * Math.PI * i) / N - Math.PI / 2;
    const cx = N === 1 ? 0 : Math.cos(theta) * ORBIT_R;
    const cy = N === 1 ? 0 : Math.sin(theta) * ORBIT_R;
    for (const summary of detail.nodes) {
      const ang = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * SEED_RADIUS;
      const prev = prevPositions?.get(summary.id);
      if (prev) warmCount += 1;
      const node: SimNode = {
        id: summary.id,
        topicId: detail.id,
        type: summary.type,
        title: summary.title || "Untitled",
        degree: 0,
        x: prev ? prev.x : cx + Math.cos(ang) * r,
        y: prev ? prev.y : cy + Math.sin(ang) * r,
      };
      simNodes.push(node);
      nodeById.set(summary.id, node);
    }
  }

  // Tree-backbone edges.
  for (const detail of ready) {
    for (const summary of detail.nodes) {
      if (!summary.parent) continue;
      if (!nodeById.has(summary.parent)) continue;
      simLinks.push({ source: summary.parent, target: summary.id, kind: "tree" });
      addEdge(summary.parent, summary.id);
    }
  }
  // Link edges (same-topic + cross-topic).
  const seen = new Set<string>();
  for (const detail of ready) {
    for (const summary of detail.nodes) {
      for (const dst of summary.links) {
        if (!nodeById.has(dst)) continue;
        const key = summary.id < dst ? `${summary.id}|${dst}` : `${dst}|${summary.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sameTopic = nodeById.get(summary.id)?.topicId === nodeById.get(dst)?.topicId;
        simLinks.push({
          source: summary.id,
          target: dst,
          kind: sameTopic ? "link" : "xlink",
        });
        addEdge(summary.id, dst);
      }
    }
  }

  // Compute degree (used for radius + reducer).
  for (const node of simNodes) {
    node.degree = adjacency.get(node.id)?.size ?? 0;
  }

  const nodeRadius = (n: SimNode) => 6 + 1.5 * Math.sqrt(n.degree);

  // Run d3-force. Parameters tuned from Quartz's defaults:
  //   charge -120 (a touch stronger than Quartz's -100·0.5; we have
  //   tighter clusters because trees are densely connected),
  //   centerForce 0.3, linkDistance 36 — plus collide for spacing.
  // Warm start: when ≥70% of nodes carry positions from the previous
  // layout, the equilibrium is already mostly found — the simulation
  // only needs to fold the newcomers in. Lower alpha keeps the settled
  // majority from being blasted apart again, and a third of the ticks
  // suffices. This is what keeps rebuilds (node added/deleted) from
  // shuffling the whole constellation.
  const warm = simNodes.length > 0 && warmCount / simNodes.length >= 0.7;
  if (simNodes.length > 1) {
    const sim = forceSimulation<SimNode>(simNodes)
      .force("charge", forceManyBody().strength(-120))
      .force("center", forceCenter(0, 0).strength(0.3))
      .force("x", forceX(0).strength(0.04)) // Pull disconnected topics closer
      .force("y", forceY(0).strength(0.04)) // Pull disconnected topics closer
      .force(
        "link",
        forceLink<SimNode, SimLink>(simLinks)
          .id((n) => n.id)
          .distance(36)
          .strength((l) => (l.kind === "xlink" ? 0.2 : 0.7)),
      )
      .force("collide", forceCollide<SimNode>((n) => nodeRadius(n) * 1.6).iterations(3))
      .stop();
    if (warm) sim.alpha(0.3);
    // Run synchronously for a fixed number of ticks. 300 is enough
    // for a cold layout to visually settle on graphs up to ~500 nodes.
    const ticks = warm ? 100 : 300;
    for (let i = 0; i < ticks; i++) sim.tick();
  }

  // Pass 2: write into a graphology graph for sigma to render.
  const g = new Graph({ multi: false, type: "undirected", allowSelfLoops: false });
  for (const node of simNodes) {
    g.addNode(node.id, {
      x: node.x ?? 0,
      y: node.y ?? 0,
      size: nodeRadius(node),
      label: node.title,
      color: palette().types[node.type],
      topicId: node.topicId,
      nodeType: node.type,
      degree: node.degree,
    });
  }
  for (const link of simLinks) {
    const sId =
      typeof link.source === "string" ? (link.source as NodeId) : link.source.id;
    const tId =
      typeof link.target === "string" ? (link.target as NodeId) : link.target.id;
    const key = `${link.kind}:${sId}->${tId}`;
    if (g.hasEdge(sId, tId)) continue;
    g.addEdgeWithKey(key, sId, tId, {
      type: link.kind === "xlink" ? "curve" : "line",
      size: link.kind === "tree" ? 1 : 1.4,
      color:
        link.kind === "tree"
          ? palette().dim
          : link.kind === "link"
            ? palette().accent
            : palette().accentDeep,
      kind: link.kind,
    });
  }

  // Pass 3: per-topic anchor (centroid + bbox top) for the floating
  // topic-name label.
  const anchorList: TopicAnchor[] = [];
  const byTopic = new Map<TopicId, SimNode[]>();
  for (const n of simNodes) {
    const arr = byTopic.get(n.topicId) ?? [];
    arr.push(n);
    byTopic.set(n.topicId, arr);
  }
  for (const detail of ready) {
    const arr = byTopic.get(detail.id);
    if (!arr || arr.length === 0) continue;
    let sumX = 0;
    let sumY = 0;
    let maxY = -Infinity;
    for (const n of arr) {
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      sumX += x;
      sumY += y;
      if (y > maxY) maxY = y;
    }
    anchorList.push({
      topicId: detail.id,
      title: detail.title,
      centerX: sumX / arr.length,
      centerY: sumY / arr.length,
      topY: maxY + 60,
      nodeCount: arr.length,
    });
  }

  const buildMs = (performance.now() - buildStart).toFixed(1);
  console.info(
    `[forest] graph built in ${buildMs}ms (${warm ? "warm" : "cold"}) · ${ready.length} topics · ${g.order} nodes · ${g.size} edges`,
  );
  return { graph: g, anchors: anchorList, neighbors: adjacency, hasNoData: false };
}
