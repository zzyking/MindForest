/**
 * Layout-quality harness: counts edge–edge crossings produced by
 * buildForestGraph on synthetic random forests, split by category
 * (tree×tree intra/inter topic, involving link/xlink edges).
 *
 * Run from web/:  npx tsx scripts/layout-crossings.mts
 *
 * Use it before/after touching the forces or the radial seed in
 * graphBuild.ts — the 2026-06 redesign (radial tidy-tree seeding)
 * was tuned entirely against these numbers. Deterministic: PRNG-seeded
 * topologies + d3-force's default deterministic randomSource.
 */
// Quantify edge crossings produced by buildForestGraph on synthetic trees.
(globalThis as any).document = { documentElement: {} };
(globalThis as any).getComputedStyle = () => ({ getPropertyValue: () => "" });

const { buildForestGraph } = await import("../src/features/forest/graphBuild");

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

function segsCross(a: number[], b: number[]): boolean {
  const [x1, y1, x2, y2] = a, [x3, y3, x4, y4] = b;
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

function countCrossings(g: any): Record<string, number> {
  const edges: { s: string; t: string; kind: string; topics: string[]; seg: number[] }[] = [];
  g.forEachEdge((_e: string, attrs: any, s: string, t: string) => {
    edges.push({ s, t, kind: attrs.kind, topics: [
      g.getNodeAttribute(s, "topicId"), g.getNodeAttribute(t, "topicId"),
    ], seg: [
      g.getNodeAttribute(s, "x"), g.getNodeAttribute(s, "y"),
      g.getNodeAttribute(t, "x"), g.getNodeAttribute(t, "y"),
    ]});
  });
  const out: Record<string, number> = { total: 0, "tree×tree intra": 0, "tree×tree inter": 0, "w/ link": 0, "w/ xlink": 0 };
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i]!, b = edges[j]!;
      if (a.s === b.s || a.s === b.t || a.t === b.s || a.t === b.t) continue;
      if (!segsCross(a.seg, b.seg)) continue;
      out.total!++;
      if (a.kind === "xlink" || b.kind === "xlink") out["w/ xlink"]!++;
      else if (a.kind === "link" || b.kind === "link") out["w/ link"]!++;
      else {
        const sameCluster = a.topics[0] === b.topics[0];
        if (sameCluster) out["tree×tree intra"]!++;
        else out["tree×tree inter"]!++;
      }
    }
  return out;
}

function makeTopic(tid: string, n: number, xlinks: number, rand: () => number) {
  const ids = Array.from({ length: n }, (_, i) => `${tid}-n${String(i).padStart(3, "0")}`);
  const nodes = ids.map((id, i) => ({
    id, parent: i === 0 ? null : ids[Math.floor(rand() * i)]!,
    type: "concept" as const, title: id, links: [] as string[],
    updated_at: "2026-01-01T00:00:00Z",
  }));
  for (let k = 0; k < xlinks; k++) {
    const a = Math.floor(rand() * n), b = Math.floor(rand() * n);
    if (a !== b && !nodes[a]!.links.includes(ids[b]!)) nodes[a]!.links.push(ids[b]!);
  }
  return {
    id: tid, title: tid, root_node_id: ids[0]!, bulletin: "",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    nodes,
  };
}

const orig = console.info; console.info = () => {};
const scenarios = [
  { name: "1 topic ×13n", topics: 1, n: 13, xl: 1 },
  { name: "1 topic ×30n", topics: 1, n: 30, xl: 2 },
  { name: "3 topics ×20n", topics: 3, n: 20, xl: 2 },
  { name: "5 topics ×40n", topics: 5, n: 40, xl: 3 },
];
for (const sc of scenarios) {
  const sums: Record<string, number> = {};
  const trials = 20; let ms = 0;
  for (let trial = 0; trial < trials; trial++) {
    const rand = mulberry32(1000 + trial);
    const topics: any = {}, details: any = {};
    for (let t = 0; t < sc.topics; t++) {
      const d = makeTopic(`t${t}`, sc.n, sc.xl, rand);
      details[d.id] = d;
      topics[d.id] = { id: d.id, title: d.title, node_count: sc.n, updated_at: d.updated_at };
    }
    const t0 = performance.now();
    const { graph } = buildForestGraph(topics, details);
    ms += performance.now() - t0;
    const c = countCrossings(graph);
    for (const [k, v] of Object.entries(c)) sums[k] = (sums[k] ?? 0) + v;
  }
  const parts = Object.entries(sums).map(([k, v]) => `${k}=${(v / trials).toFixed(2)}`).join("  ");
  orig(`${sc.name}: ${parts} (avg ${(ms / trials).toFixed(0)}ms)`);
}
