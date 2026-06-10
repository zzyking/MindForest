/**
 * Verifies presettleForFit's contract, on which the cold-mount camera
 * fix depends:
 *   1. it restores the live layout to its EXACT seed (positions +
 *      zeroed velocity) — a leak here would corrupt the live bloom;
 *   2. the captured rest bbox is meaningfully larger than the seed bbox
 *      — i.e. it actually measures the expansion the seed-sized fit used
 *      to miss;
 *   3. a fresh bloom (alpha 0.6 from the restored seed) converges to the
 *      SAME bbox presettle captured — proving the camera, framed against
 *      the presettle positions, frames exactly where the live bloom
 *      comes to rest. This is what makes a cold mount rest at the warm
 *      switch-back size.
 *
 * Run from web/:  npx tsx scripts/presettle-check.mts
 */
(globalThis as any).document = { documentElement: {} };
(globalThis as any).getComputedStyle = () => ({ getPropertyValue: () => "" });

const { createForestLayout, syncForestStructure, presettleForFit } = await import(
  "../src/features/forest/graphBuild"
);

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

function makeTopic(tid: string, n: number, xlinks: number, rand: () => number) {
  const ids = Array.from({ length: n }, (_, i) => `${tid}-n${String(i).padStart(3, "0")}`);
  const nodes = ids.map((id, i) => ({
    id,
    parent: i === 0 ? null : ids[Math.floor(rand() * i)]!,
    type: "concept" as const,
    title: id,
    links: [] as string[],
    updated_at: "2026-01-01T00:00:00Z",
  }));
  for (let k = 0; k < xlinks; k++) {
    const a = Math.floor(rand() * n);
    const b = Math.floor(rand() * n);
    if (a !== b && !nodes[a]!.links.includes(ids[b]!)) nodes[a]!.links.push(ids[b]!);
  }
  return {
    id: tid,
    title: tid,
    root_node_id: ids[0]!,
    bulletin: "",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    nodes,
  };
}

const bbox = (pts: { x: number; y: number }[]) => {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { w: maxX - minX, h: maxY - minY };
};

console.info = () => {};
const scenarios = [
  { name: "1 topic ×13n", topics: 1, n: 13, xl: 1 },
  { name: "3 topics ×20n", topics: 3, n: 20, xl: 2 },
  { name: "5 topics ×40n", topics: 5, n: 40, xl: 3 },
];

let pass = true;
for (const sc of scenarios) {
  const rand = mulberry32(42);
  const topics: any = {}, details: any = {};
  for (let t = 0; t < sc.topics; t++) {
    const d = makeTopic(`t${t}`, sc.n, sc.xl, rand);
    details[d.id] = d;
    topics[d.id] = { id: d.id, title: d.title, node_count: sc.n, updated_at: d.updated_at };
  }

  const layout = createForestLayout();
  syncForestStructure(layout, topics, details);

  // Seed snapshot before presettle.
  const seed = layout.simNodes.map((n) => ({ id: n.id, x: n.x ?? 0, y: n.y ?? 0 }));
  const rest = presettleForFit(layout);

  // (1) exact restore + zeroed velocity
  let maxDrift = 0;
  let maxVel = 0;
  for (const s of seed) {
    const n = layout.nodeById.get(s.id)!;
    maxDrift = Math.max(maxDrift, Math.abs((n.x ?? 0) - s.x), Math.abs((n.y ?? 0) - s.y));
    maxVel = Math.max(maxVel, Math.abs(n.vx ?? 0), Math.abs(n.vy ?? 0));
  }

  // (2) rest bbox vs seed bbox — the scale shift is real and varies per
  // graph (and flips direction!), so the seed is NOT a usable proxy for
  // the rest scale and no constant padding can stand in for it.
  const seedBox = bbox(seed);
  const restBox = bbox([...rest.values()]);
  const growth = (restBox.w * restBox.h) / (seedBox.w * seedBox.h);

  // (3) a fresh bloom from the restored seed converges to ~the rest bbox
  layout.sim.alpha(0.6);
  for (let i = 0; i < 400 && layout.sim.alpha() > layout.sim.alphaMin(); i++) layout.sim.tick();
  const bloomBox = bbox(layout.simNodes.map((n) => ({ x: n.x ?? 0, y: n.y ?? 0 })));
  const sizeMatch =
    Math.max(bloomBox.w / restBox.w, restBox.w / bloomBox.w, bloomBox.h / restBox.h, restBox.h / bloomBox.h);

  // Verdict keys on the two real guarantees: exact restore (no bloom
  // corruption) and fit==bloom (cold rests at the framed size). Growth
  // is reported as evidence the scale shift is non-trivial (|Δ|>5%).
  const ok = maxDrift < 1e-9 && maxVel < 1e-9 && Math.abs(growth - 1) > 0.05 && sizeMatch < 1.02;
  pass = pass && ok;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${sc.name.padEnd(14)} ` +
      `restore-drift=${maxDrift.toExponential(1)} vel=${maxVel.toExponential(1)} ` +
      `seed→rest area=${growth.toFixed(2)}× ` +
      `fit-vs-bloom size ratio=${sizeMatch.toFixed(4)}`,
  );
}
console.log(pass ? "\nALL PASS — cold fit frames the resting scale, seed restored intact." : "\nFAILURES above.");
process.exit(pass ? 0 : 1);
