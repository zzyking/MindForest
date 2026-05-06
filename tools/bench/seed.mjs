#!/usr/bin/env node
/**
 * Synthetic data generator for the Forest perf bench.
 *
 * Hits a running MindForest API and creates N topics × M nodes with a
 * configurable density of cross-topic links. Default: 10 topics ×
 * 500 nodes = 5,000 nodes total, ~5% link density.
 *
 * Usage:
 *   node tools/bench/seed.mjs [--api http://127.0.0.1:8787]
 *                             [--topics 10] [--per-topic 500]
 *                             [--link-density 0.05]
 *                             [--prefix bench]
 *
 * Idempotency: each run uses a fresh `prefix-<rand>-N` topic title so
 * re-running adds *more* synthetic data rather than colliding. To start
 * from a clean slate, point the API at an empty vault dir
 * (`MINDFOREST_VAULT=$(mktemp -d) cargo run -p api`).
 *
 * Reports per-phase wall time so we can see whether the bottleneck is
 * server side (creating files/index entries) before we try to optimize
 * the client.
 */

const WORDS = [
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
  "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi", "rho",
  "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega",
  "north", "south", "east", "west", "centre", "edge", "ring", "core",
  "graph", "tree", "forest", "node", "leaf", "branch", "trunk",
  "vector", "matrix", "tensor", "scalar", "field", "group", "monoid",
  "wave", "particle", "force", "mass", "energy", "spin", "charge",
];
const TYPES = ["concept", "fact", "source", "example", "question", "task", "misc"];

const args = parseArgs(process.argv.slice(2));
const API = args.api ?? "http://127.0.0.1:8787";
const TOPICS = Number(args.topics ?? 10);
const PER_TOPIC = Number(args["per-topic"] ?? 500);
const LINK_DENSITY = Number(args["link-density"] ?? 0.05);
const PREFIX = args.prefix ?? `bench-${Date.now().toString(36)}`;

console.log(`API:        ${API}`);
console.log(`Topics:     ${TOPICS}`);
console.log(`Per topic:  ${PER_TOPIC}`);
console.log(`Total:      ${TOPICS * PER_TOPIC} nodes`);
console.log(`Links:      ~${Math.round(LINK_DENSITY * 100)}% of nodes get one cross-link`);
console.log("");

await ensureHealthy();

const t0 = Date.now();
const topics = [];
for (let i = 0; i < TOPICS; i++) {
  const title = `${PREFIX}-topic-${i + 1}`;
  const t = await req("POST", "/v1/topics", { title });
  topics.push(t);
  process.stdout.write(`\r  topics: ${i + 1}/${TOPICS}`);
}
console.log(`\n  ✓ topics created in ${ms(t0)}`);

const allNodes = []; // { id, topic, depth }

const t1 = Date.now();
let createdNodes = 0;
for (const topic of topics) {
  const topicNodes = [{ id: topic.root_node_id, topic: topic.id, depth: 0 }];
  for (let i = 1; i < PER_TOPIC; i++) {
    // Pick a random parent from existing nodes in this topic. Bias
    // toward shallower nodes so trees fan out a bit instead of becoming
    // long ladders.
    const parent = pickParent(topicNodes);
    const node = await req("POST", "/v1/nodes", {
      topic: topic.id,
      parent: parent.id,
      title: titleOf(i),
      content: synthBody(i),
      node_type: pickType(),
    });
    topicNodes.push({ id: node.id, topic: topic.id, depth: parent.depth + 1 });
    createdNodes++;
    if (createdNodes % 100 === 0) {
      process.stdout.write(
        `\r  nodes: ${createdNodes}/${TOPICS * (PER_TOPIC - 1)} (${rate(t1, createdNodes)}/s)`,
      );
    }
  }
  allNodes.push(...topicNodes);
}
console.log(`\n  ✓ nodes created in ${ms(t1)} (${rate(t1, createdNodes)}/s)`);

const t2 = Date.now();
const linkCount = Math.round(allNodes.length * LINK_DENSITY);
let linksMade = 0;
for (let i = 0; i < linkCount; i++) {
  const a = allNodes[Math.floor(Math.random() * allNodes.length)];
  let b = allNodes[Math.floor(Math.random() * allNodes.length)];
  // Only count cross-topic links toward our budget — same-topic refs
  // are useful too but not the metric we're stress-testing.
  for (let attempt = 0; attempt < 5 && b.topic === a.topic; attempt++) {
    b = allNodes[Math.floor(Math.random() * allNodes.length)];
  }
  if (a.id === b.id) continue;
  // Read current links so we don't overwrite. Two reads for one write
  // — fine at this scale, the API server is local.
  const node = await req("GET", `/v1/nodes/${a.id}`);
  if (node.links.includes(b.id)) continue;
  await req("PATCH", `/v1/nodes/${a.id}`, {
    links: [...node.links, b.id],
  });
  linksMade++;
  if (linksMade % 50 === 0) {
    process.stdout.write(`\r  links: ${linksMade}/${linkCount}`);
  }
}
console.log(`\n  ✓ ${linksMade} links created in ${ms(t2)}`);

console.log(`\nTotal wall time: ${ms(t0)}.`);
console.log(`Open the app in Forest mode and inspect /v1/topics for the new ${PREFIX}-topic-* entries.`);

// ─── Helpers ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) {
        out[k] = "true";
      } else {
        out[k] = v;
        i++;
      }
    }
  }
  return out;
}

async function ensureHealthy() {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`${API}/health`);
      if (r.ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(`API not reachable at ${API}/health`);
  process.exit(1);
}

async function req(method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${method} ${path} → ${r.status} ${text}`);
  }
  return r.json();
}

function pickParent(nodes) {
  // Bias toward shallow: weight ∝ 1 / (1 + depth). Cheap O(n) sample —
  // n stays small (per topic) so we don't bother with a fancier method.
  let total = 0;
  for (const n of nodes) total += 1 / (1 + n.depth);
  let pick = Math.random() * total;
  for (const n of nodes) {
    pick -= 1 / (1 + n.depth);
    if (pick <= 0) return n;
  }
  return nodes[nodes.length - 1];
}

function pickType() {
  return TYPES[Math.floor(Math.random() * TYPES.length)];
}

function titleOf(i) {
  const w = WORDS[i % WORDS.length];
  return `${w}-${i}`;
}

function synthBody(i) {
  const lines = [];
  for (let j = 0; j < 3; j++) {
    const start = (i + j * 7) % WORDS.length;
    const phrase = WORDS.slice(start, start + 12).join(" ");
    lines.push(phrase);
  }
  return lines.join("\n\n");
}

function ms(t0) {
  const elapsed = Date.now() - t0;
  return elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
}

function rate(t0, count) {
  const sec = Math.max(0.001, (Date.now() - t0) / 1000);
  return Math.round(count / sec);
}

