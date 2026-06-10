/**
 * ForestView — workspace-wide knowledge graph in the spirit of
 * Quartz's graph view.
 *
 * Reference: https://github.com/jackyzha0/quartz/blob/v4/quartz/components/scripts/graph.inline.ts
 *
 * Design:
 *   - One unified graph of every node across every topic.
 *   - Layout via d3-force (manyBody + center + link + collide). No
 *     orbit seeding; topics emerge as visual clusters because their
 *     nodes are densely connected within and sparsely across.
 *   - Node radius = 4 + sqrt(degree). Hubs read bigger, leaves smaller.
 *   - Labels hidden by default; only the hovered node and its direct
 *     neighbours light up + show titles. Everything else dims to 0.15
 *     alpha. Same affordance as the Quartz graph.
 *   - Same-topic links straight, cross-topic links curved.
 *   - Click navigates to the node.
 *   - Topic labels float above each cluster's centroid (post-settle)
 *     for orientation; click navigates to that topic's root.
 *
 * Lifecycle: rebuild graph + re-run simulation when topicDetails or
 * focus changes; sigma instance is single-use, killed and recreated.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import EdgeCurveProgram from "@sigma/edge-curve";
import { cn } from "@/lib/cn";
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
import Sigma from "sigma";

import { useFocusNode } from "@/app/navigation";
import { useForestData } from "@/stores/forestData";
import { useWorkspaceUI, type ForestCameraMode } from "@/stores/workspaceUI";
import type { NodeId, NodeType, TopicDetail, TopicId } from "@/lib/types";

interface Props {
  focusedTopicId: TopicId;
  focusedNodeId: NodeId;
}

// Hover dim alpha for non-neighbour nodes / edges.
const DIM_ALPHA = 0.3;
const HOVER_SCALE = 0.16;

// Palette — sigma renders to canvas/webgl so we can't reach CSS vars
// from inside its render loop. Read them once at module-first-use,
// cache the result, and serve a plain JS object from there. tokens.css
// is the single source of truth; adjust shades there.
interface Palette {
  ink: string;
  dim: string;
  accent: string;
  accentDeep: string;
  label: string;
  /** RGB triplet form of `label`, so callers can splice an alpha
   *  channel in (`rgba(${r}, ${g}, ${b}, ${a})`) without re-parsing. */
  labelRgb: [number, number, number];
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
function palette(): Palette {
  if (_palette) return _palette;
  const cs = getComputedStyle(document.documentElement);
  // Fallbacks match tokens.css 1:1. If Tailwind's @theme block ever
  // stops emitting a custom var (e.g. it gets pruned as "unused"), the
  // canvas keeps a defined colour instead of "" which would draw
  // nothing.
  const v = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  const label = v("--color-forest-canvas-label", "#3e4b41");
  _palette = {
    ink: v("--color-forest-canvas-ink", "#152019"),
    dim: v("--color-forest-canvas-dim", "#b8c8be"),
    accent: v("--color-accent", "#d47a5d"),
    accentDeep: v("--color-accent-deep", "#a85c3f"),
    label,
    labelRgb: hexToRgb(label),
    types: {
      concept: v("--color-type-concept", "#7b9082"),
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

interface TopicAnchor {
  topicId: TopicId;
  title: string;
  centerX: number;
  centerY: number;
  topY: number;
  nodeCount: number;
}

export function ForestView({ focusedTopicId, focusedNodeId }: Props) {
  const topics = useForestData((s) => s.topics);
  const topicDetails = useForestData((s) => s.topicDetails);
  const detailLoading = useForestData((s) => s.loading.topicDetail);
  const fetchTopics = useForestData((s) => s.fetchTopics);
  const fetchTopic = useForestData((s) => s.fetchTopic);
  const forestCameraIntent = useWorkspaceUI((s) => s.forestCameraIntent);
  const consumeForestCameraIntent = useWorkspaceUI((s) => s.consumeForestCameraIntent);
  const sidebarOpen = useWorkspaceUI((s) => s.sidebarOpen);
  const focus = useFocusNode();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const hoverProgressRef = useRef(0);
  const hoverAnimFrameRef = useRef<number | null>(null);
  // The graph point we *want* to keep at viewport center across resizes
  // (sidebar toggle, window resize). Updated whenever the user/system
  // makes a deliberate camera move: initial fit, focus-on-node, click,
  // forestCameraIntent. NOT updated on every render — so an interim
  // sidebar resize doesn't read whatever happens to be at the screen
  // center during the transition.
  const cameraAnchorRef = useRef<{ x: number; y: number } | null>(null);

  // Hover state — both the node id and its neighbour set, computed
  // once per hover change so the reducer can do a single Set lookup.
  const [hoverNode, setHoverNode] = useState<NodeId | null>(null);
  // Sigma init takes a real bite of main-thread time (d3-force 300 ticks
  // + canvas allocation). Outer NodePage wrapper animation finishes
  // before sigma even paints, so the entrance is invisible. We gate
  // ForestView's own opacity+scale transition on `sigmaReady`, flipped
  // to true one frame after sigma is constructed — guaranteeing the
  // "settle in" lands on actual rendered content.
  const [sigmaReady, setSigmaReady] = useState(false);
  const neighborsRef = useRef<Set<NodeId>>(new Set());
  
  // Keep track of the active set during fade-out so they remain opaque
  const activeDimSetRef = useRef<{ hovered: NodeId | null; neighbors: Set<NodeId> }>({
    hovered: null,
    neighbors: new Set(),
  });

  useEffect(() => {
    void fetchTopics().catch(() => {});
  }, [fetchTopics]);

  useEffect(() => {
    for (const id of Object.keys(topics) as TopicId[]) {
      if (!topicDetails[id] && !detailLoading[id]) {
        void fetchTopic(id).catch(() => {});
      }
    }
  }, [topics, topicDetails, detailLoading, fetchTopic]);

  // Build + lay out the graph. Returns the assembled graphology graph,
  // the per-topic anchors (computed from settled positions), and a
  // neighbour adjacency map used by the hover reducer.
  const { graph, anchors, neighbors, hasNoData } = useMemo(() => {
    const buildStart = performance.now();
    const ready: TopicDetail[] = (Object.keys(topics) as TopicId[])
      .sort()
      .map((id) => topicDetails[id])
      .filter((d): d is TopicDetail => Boolean(d));

    if (ready.length === 0) {
      return {
        graph: null as Graph | null,
        anchors: [] as TopicAnchor[],
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
    for (let i = 0; i < ready.length; i++) {
      const detail = ready[i]!;
      const theta = N === 1 ? 0 : (2 * Math.PI * i) / N - Math.PI / 2;
      const cx = N === 1 ? 0 : Math.cos(theta) * ORBIT_R;
      const cy = N === 1 ? 0 : Math.sin(theta) * ORBIT_R;
      for (const summary of detail.nodes) {
        const ang = rand() * Math.PI * 2;
        const r = Math.sqrt(rand()) * SEED_RADIUS;
        const node: SimNode = {
          id: summary.id,
          topicId: detail.id,
          type: summary.type,
          title: summary.title || "Untitled",
          degree: 0,
          x: cx + Math.cos(ang) * r,
          y: cy + Math.sin(ang) * r,
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
      // Run synchronously for a fixed number of ticks. 300 is enough
      // for the layout to visually settle on graphs up to ~500 nodes.
      const ticks = 300;
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
      `[forest] graph built in ${buildMs}ms · ${ready.length} topics · ${g.order} nodes · ${g.size} edges`,
    );
    return { graph: g, anchors: anchorList, neighbors: adjacency, hasNoData: false };
  }, [topics, topicDetails]);

  // Keep the neighbour map in a ref so the reducer can read it
  // without re-creating sigma.
  useEffect(() => {
    neighborsRef.current = new Set();
  }, [graph]);

  const labelsLayerRef = useRef<HTMLDivElement | null>(null);
  const labelNodeRefs = useRef(new Map<TopicId, HTMLDivElement>());

  const focusedNodeIdRef = useRef(focusedNodeId);
  const focusedTopicIdRef = useRef(focusedTopicId);
  useEffect(() => {
    focusedNodeIdRef.current = focusedNodeId;
    const s = sigmaRef.current;
    if (!s || !graph) {
      focusedTopicIdRef.current = focusedTopicId;
      return;
    }

    focusedTopicIdRef.current = focusedTopicId;
    const cameraMode = getForestCameraMode({
      focusedNodeId,
      focusedTopicId,
      intent: forestCameraIntent,
    });
    if (!cameraMode) return;

    const target = resolveCameraTarget({
      focusedNodeId,
      focusedTopicId,
      graph,
      cameraMode,
      topicDetails,
    });
    if (!target) return;

    s.refresh();
    animateCameraToPoint(s, target, { duration: 400 });
    cameraAnchorRef.current = target;
    s.refresh();
    consumeForestCameraIntent(focusedNodeId, focusedTopicId);
  }, [
    consumeForestCameraIntent,
    focusedNodeId,
    focusedTopicId,
    forestCameraIntent,
    graph,
    topicDetails,
  ]);

  useEffect(() => {
    // Reset visibility on every graph rebuild so the next reveal
    // triggers a fresh transition (false → true) rather than being
    // batched away.
    setSigmaReady(false);
    if (!containerRef.current || !graph) return;
    if (sigmaRef.current) {
      sigmaRef.current.kill();
      sigmaRef.current = null;
    }

    const customDrawLabel = (context: CanvasRenderingContext2D, data: any, settings: any) => {
      if (!data.label) return;
      const hoverBoost = hoverProgressRef.current;
      const labelAlpha = Math.max(0, (hoverBoost - 0.4) / 0.6);
      if (labelAlpha <= 0) return;

      const size = settings.labelSize;
      context.font = `${settings.labelWeight || "normal"} ${size}px ${settings.labelFont}`;

      if (data.isHoveredNode) {
        const textWidth = context.measureText(data.label).width;

        // 胶囊形状包住 Node 和 Label
        const padding = 6;
        const r = Math.max(data.size + 4, size / 2 + 4);
        const lcX = data.x; // 左侧圆心与节点同心
        const textStartX = data.x + data.size + padding;
        
        // 动画：向右平滑展开（为了让展开有冲刺的灵动感，使用开方 easing）
        const fullRcX = textStartX + textWidth;
        const expandProgress = Math.pow(labelAlpha, 0.5);
        const rcX = lcX + (fullRcX - lcX) * expandProgress;

        context.save();
        context.beginPath();
        // 画左半圆：从 90度（底）顺时针画到 -90度（顶），覆盖整个左侧
        context.arc(lcX, data.y, r, Math.PI / 2, -Math.PI / 2);
        context.lineTo(rcX, data.y - r);
        // 画右半圆：从 -90度（顶）顺时针画到 90度（底），覆盖整个右侧
        context.arc(rcX, data.y, r, -Math.PI / 2, Math.PI / 2);
        context.closePath();

        // 背景 (sand-50 玻璃态)
        context.fillStyle = `rgba(249, 247, 242, ${labelAlpha * 0.95})`;
        context.fill();
        // 细边框 (forest-200)
        context.lineWidth = 1;
        context.strokeStyle = `rgba(204, 214, 209, ${labelAlpha})`;
        context.stroke();

        // 裁切后续绘制（含文字），实现“向右遮罩揭开”的抽出效果
        context.clip();

        // 文字 (color-label)
        // 文字虽然一直画在原本最终的固定位置，但在展开过程中未达到的区域会被 mask 裁切掉
        context.fillStyle = `rgba(62, 75, 65, ${labelAlpha})`;
        context.fillText(data.label, textStartX, data.y + size / 3);

        context.restore();

        // 裁切区域释放后，重新在顶层画出高亮的节点实体，避免被沙色背景遮挡
        context.beginPath();
        context.arc(data.x, data.y, data.size, 0, Math.PI * 2);
        context.fillStyle = data.color || palette().dim;
        context.fill();
      } else {
        // Label text without a backdrop. Tracks --color-forest-canvas-label
        // via the palette so a token tweak doesn't desync this line.
        const [lr, lg, lb] = palette().labelRgb;
        context.fillStyle = `rgba(${lr}, ${lg}, ${lb}, ${labelAlpha})`;
        context.fillText(data.label, data.x + data.size + 3, data.y + size / 3);
      }
    };

    const s = new Sigma(graph, containerRef.current, {
      // Labels off by default — only the hovered node + its neighbours
      // get `forceLabel: true` via the reducer.
      renderLabels: true,
      labelSize: 12,
      labelFont: "system-ui, sans-serif",
      labelColor: { attribute: "labelColor", color: palette().label },
      labelRenderedSizeThreshold: Infinity,
      defaultEdgeColor: palette().dim,
      defaultNodeColor: palette().dim,
      minCameraRatio: 0.05,
      maxCameraRatio: 4,
      hideLabelsOnMove: true,
      hideEdgesOnMove: false,
      edgeProgramClasses: { curve: EdgeCurveProgram },
      
      defaultDrawNodeHover: customDrawLabel,
      defaultDrawNodeLabel: customDrawLabel,

      nodeReducer: (id, attrs) => {
        const out: any = { ...attrs };

        if (id === focusedNodeIdRef.current) {
          out.color = palette().ink;
        }

        const hoverBoost = hoverProgressRef.current;
        
        if (hoverBoost > 0) {
          // If actively hovering, use current ref. During fade-out (hovered=null), use activeDimSetRef
          const isActivelyHovered = sigmaHoverRef.current !== null;
          const hovered = isActivelyHovered ? sigmaHoverRef.current : activeDimSetRef.current.hovered;
          const neighborSet = isActivelyHovered ? neighborsRef.current : activeDimSetRef.current.neighbors;

          const isHovered = id === hovered;
          const isNeighbor = neighborSet.has(id as NodeId);

          if (isHovered || isNeighbor) {
            out.forceLabel = true;
            out.isHoveredNode = isHovered; // 传递标志位给自定义Renderer
            if (isHovered) {
              out.size = attrs.size * (1 + HOVER_SCALE * hoverBoost);
            }
          } else {
            const currentAlpha = 1 - (1 - DIM_ALPHA) * hoverBoost;
            out.color = withAlpha(attrs.color as string, currentAlpha);
            out.label = "";
          }
        }
        return out as typeof attrs;
      },
      edgeReducer: (id, attrs) => {
        const out: typeof attrs = { ...attrs };
        const hoverBoost = hoverProgressRef.current;
        
        if (hoverBoost > 0 && graph.hasEdge(id)) {
          const isActivelyHovered = sigmaHoverRef.current !== null;
          const hovered = isActivelyHovered ? sigmaHoverRef.current : activeDimSetRef.current.hovered;

          if (hovered) {
            const [src, tgt] = graph.extremities(id);
            if (src !== hovered && tgt !== hovered) {
              const currentAlpha = 1 - (1 - DIM_ALPHA) * hoverBoost;
              out.color = withAlpha(attrs.color as string, currentAlpha);
            }
          }
        }
        return out;
      },
    });

    const projectOverlays = () => {
      for (const a of anchors) {
        const label = labelNodeRefs.current.get(a.topicId);
        if (!label) continue;
        const v = s.graphToViewport({ x: a.centerX, y: a.topY });
        label.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) translate(-50%, -100%)`;
      }
    };

    const setHover = (id: NodeId | null) => {
      sigmaHoverRef.current = id;
      const newNeighbors: Set<NodeId> = id
        ? (neighbors.get(id) ?? new Set<NodeId>())
        : new Set<NodeId>();
      neighborsRef.current = newNeighbors;
      if (id) {
        activeDimSetRef.current = { hovered: id, neighbors: newNeighbors };
      }
      setHoverNode(id);
    };

    s.refresh();

    s.on("clickNode", ({ node }) => {
      const topicId = graph.getNodeAttribute(node, "topicId") as TopicId;
      const x = graph.getNodeAttribute(node, "x") as number;
      const y = graph.getNodeAttribute(node, "y") as number;

      void focus(node as NodeId, topicId);
      animateCameraToPoint(s, { x, y }, { duration: 400 });
      cameraAnchorRef.current = { x, y };
    });
    s.on("enterNode", ({ node }) => setHover(node as NodeId));
    s.on("leaveNode", () => setHover(null));
    s.getCamera().on("updated", projectOverlays);
    s.on("afterRender", projectOverlays);

    sigmaRef.current = s;
    fitCameraToGraph(s, graph);
    // Default anchor = the graph point that the fit just centred —
    // i.e. the current viewport centre in graph coords.
    {
      const { width, height } = s.getDimensions();
      if (width > 0 && height > 0) {
        cameraAnchorRef.current = s.viewportToGraph({ x: width / 2, y: height / 2 });
      }
    }

    if (focusedNodeIdRef.current && graph.hasNode(focusedNodeIdRef.current)) {
      const target =
        resolveCameraTarget({
          focusedNodeId: focusedNodeIdRef.current,
          focusedTopicId: focusedTopicIdRef.current,
          graph,
          // Graph rebuilds can be caused by background topic-detail hydration
          // before the route focus changes. Preserve the current node then;
          // route-driven topic changes are handled by the focus effect above.
          cameraMode: "node",
          topicDetails,
        }) ?? getGraphNodePosition(graph, focusedNodeIdRef.current);
      if (!target) {
        projectOverlays();
        return () => {
          if (hoverAnimFrameRef.current !== null) {
            cancelAnimationFrame(hoverAnimFrameRef.current);
            hoverAnimFrameRef.current = null;
          }
          s.kill();
          sigmaRef.current = null;
        };
      }
      setCameraToPoint(s, target);
      cameraAnchorRef.current = target;
    }

    projectOverlays();

    // Reveal one frame after sigma is constructed so the entrance
    // transition starts the moment the first real frame paints, not
    // before. Without this the outer NodePage wrapper finishes
    // animating while the canvas is still blank.
    const revealRafId = requestAnimationFrame(() => setSigmaReady(true));

    return () => {
      cancelAnimationFrame(revealRafId);
      if (hoverAnimFrameRef.current !== null) {
        cancelAnimationFrame(hoverAnimFrameRef.current);
        hoverAnimFrameRef.current = null;
      }
      s.kill();
      sigmaRef.current = null;
    };
  }, [graph, focus, anchors, neighbors]);

  // Keep `cameraAnchorRef` at viewport center while the sidebar's grid
  // track animates over ~350ms. The anchor is whatever the user last
  // expressed intent about (initial fit, focused node, click, route
  // intent) — it is NOT "whatever's at the centre right now"
  // mid-transition, which the previous implementation got wrong and
  // produced a focused-node drift exactly equal to the sidebar width.
  //
  // Per frame we force `sigma.resize(true)` before `setCameraToPoint` —
  // sigma's internal ResizeObserver batches its dimension updates and
  // can lag the actual DOM size during a layout-property transition.
  // `setCameraToPoint` reads `sigma.getDimensions()` to compute the
  // framedGraph offset, so stale dimensions = off-center anchor.
  useEffect(() => {
    const anchor = cameraAnchorRef.current;
    if (!anchor) return;
    if (!sigmaRef.current) return;

    const startTime = performance.now();
    const duration = 380;
    let rafId = 0;
    const tick = () => {
      const live = sigmaRef.current;
      if (!live) return;
      live.resize(true);
      setCameraToPoint(live, anchor);
      if (performance.now() - startTime < duration) {
        rafId = requestAnimationFrame(tick);
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [sidebarOpen]);

  useEffect(() => {
    if (!sigmaRef.current) return;

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (hoverAnimFrameRef.current !== null) {
      cancelAnimationFrame(hoverAnimFrameRef.current);
      hoverAnimFrameRef.current = null;
    }

    const target = hoverNode ? 1 : 0;
    if (reduceMotion) {
      hoverProgressRef.current = target;
      sigmaRef.current.refresh();
      return;
    }

    const start = hoverProgressRef.current;
    const startTime = performance.now();
    const duration = 250; // increased from 160ms for smoother visual fading

    const tick = (now: number) => {
      const t = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      hoverProgressRef.current = start + (target - start) * eased;
      sigmaRef.current?.refresh();
      if (t < 1) {
        hoverAnimFrameRef.current = requestAnimationFrame(tick);
      } else {
        hoverAnimFrameRef.current = null;
      }
    };

    hoverAnimFrameRef.current = requestAnimationFrame(tick);

    return () => {
      if (hoverAnimFrameRef.current !== null) {
        cancelAnimationFrame(hoverAnimFrameRef.current);
        hoverAnimFrameRef.current = null;
      }
    };
  }, [hoverNode]);

  const srSummary = useMemo(() => {
    if (!graph) return "";
    const topicCount = anchors.length;
    const totalNodes = graph.order;
    const topicTitles = anchors.map((a) => `${a.title} (${a.nodeCount})`).join(", ");
    return `Forest map of the workspace. ${topicCount} topic${topicCount === 1 ? "" : "s"}, ${totalNodes} node${totalNodes === 1 ? "" : "s"} total. Topics: ${topicTitles}.`;
  }, [anchors, graph]);

  if (hasNoData) {
    return (
      <div className="text-forest-400 flex h-full items-center justify-center text-sm">
        No topics yet.
      </div>
    );
  }
  if (!graph) {
    return (
      <div className="text-forest-400 flex h-full items-center justify-center text-sm">
        Loading…
      </div>
    );
  }

  return (
    <div
      className={cn(
        "bg-forest-50 relative h-full w-full overflow-hidden",
        // Matches tree-card-in's curve + the NodePage wrapper; combined
        // with sigmaReady gating below, the visible "settle in" starts
        // exactly when sigma's first canvas frame paints.
        "transition-[opacity,transform] duration-[320ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]",
        sigmaReady ? "opacity-100 scale-100" : "opacity-0 scale-[0.97]",
      )}
      role="region"
      aria-label="Forest map of the workspace"
    >
      <div
        ref={containerRef}
        className="absolute inset-0"
        role="application"
        aria-label={srSummary || "Forest canvas"}
        style={{ cursor: hoverNode ? "pointer" : "grab", backgroundColor: "transparent" }}
      />
      <div className="sr-only">
        <p>{srSummary}</p>
        {anchors.map((a) => (
          <p key={a.topicId}>
            {a.title}: {a.nodeCount} node{a.nodeCount === 1 ? "" : "s"}.
          </p>
        ))}
      </div>
      <div ref={labelsLayerRef} className="pointer-events-none absolute inset-0">
        {anchors.map((a) => {
          const focused = a.topicId === focusedTopicId;
          const detail = topicDetails[a.topicId];
          return (
            <div
              key={a.topicId}
              ref={(el) => {
                if (el) labelNodeRefs.current.set(a.topicId, el);
                else labelNodeRefs.current.delete(a.topicId);
              }}
              className="absolute left-0 top-0 whitespace-nowrap will-change-transform"
            >
              <button
                type="button"
                onClick={() => {
                  if (detail) {
                    void focus(detail.root_node_id, detail.id, {
                      forestCameraMode: "topic-root",
                    });
                  }
                }}
                className={
                  "pointer-events-auto border-forest-200 bg-forest-50/90 hover:bg-sand-100 hover:border-forest-300 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-serif backdrop-blur-md shadow-glass transition-colors " +
                  (focused
                    ? "text-forest-900 border-accent ring-1 ring-accent/30"
                    : "text-forest-700")
                }
              >
                <span className="text-base leading-none">{a.title}</span>
                <span className="text-forest-400 text-[10px] uppercase tracking-[0.08em] tabular-nums">
                  {a.nodeCount}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Module-level ref keeping the current hover id readable from sigma's
// reducer closures without forcing a full sigma re-create on every
// hover tick.
const sigmaHoverRef: { current: NodeId | null } = { current: null };

function getGraphNodePosition(graph: Graph, nodeId: NodeId): { x: number; y: number } | null {
  if (!graph.hasNode(nodeId)) return null;
  return {
    x: graph.getNodeAttribute(nodeId, "x") as number,
    y: graph.getNodeAttribute(nodeId, "y") as number,
  };
}

function getFramedGraphPoint(sigma: Sigma, point: { x: number; y: number }) {
  const conversion = {
    cameraState: sigma.getCamera().getState(),
    viewportDimensions: sigma.getDimensions(),
    graphDimensions: sigma.getGraphDimensions(),
    padding: sigma.getStagePadding(),
  };
  const view = sigma.graphToViewport(point, conversion);
  return sigma.viewportToFramedGraph(view, conversion);
}

function animateCameraToPoint(
  sigma: Sigma,
  point: { x: number; y: number },
  options: { duration: number },
) {
  const framed = getFramedGraphPoint(sigma, point);
  // sigma camera animations are JS-driven (not CSS), so the global
  // prefers-reduced-motion override in globals.css doesn't reach them.
  // Honour the preference here by jumping to the target instead.
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) {
    sigma.getCamera().setState({ x: framed.x, y: framed.y });
    return;
  }
  sigma.getCamera().animate({ x: framed.x, y: framed.y }, { duration: options.duration });
}

function setCameraToPoint(sigma: Sigma, point: { x: number; y: number }) {
  const framed = getFramedGraphPoint(sigma, point);
  sigma.getCamera().setState({ x: framed.x, y: framed.y });
}

function resolveCameraTarget({
  focusedNodeId,
  focusedTopicId,
  cameraMode,
  graph,
  topicDetails,
}: {
  focusedNodeId: NodeId;
  focusedTopicId: TopicId;
  cameraMode: ForestCameraMode;
  graph: Graph;
  topicDetails: Record<TopicId, TopicDetail | undefined>;
}): { x: number; y: number } | null {
  if (cameraMode === "node") {
    return getGraphNodePosition(graph, focusedNodeId);
  }

  const detail = topicDetails[focusedTopicId];
  const topicRootTarget = detail ? getGraphNodePosition(graph, detail.root_node_id) : null;
  if (topicRootTarget) return topicRootTarget;

  return getGraphNodePosition(graph, focusedNodeId);
}

function getForestCameraMode({
  focusedNodeId,
  focusedTopicId,
  intent,
}: {
  focusedNodeId: NodeId;
  focusedTopicId: TopicId;
  intent: {
    targetNodeId: NodeId;
    topicId: TopicId;
    mode: ForestCameraMode;
  } | null;
}): ForestCameraMode | null {
  if (!intent) return "node";
  if (intent.targetNodeId === focusedNodeId && intent.topicId === focusedTopicId) {
    return intent.mode;
  }
  return null;
}

/** Blend a #rrggbb with the sand background to simulate alpha. */
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("rgba(")) return color;
  if (!color.startsWith("#")) return color;

  const bg = "#f9f7f2"; // matches sand-50/100 roughly
  const n = color.length === 7 ? color : color === "#000" ? "#000000" : color;

  const fgR = parseInt(n.slice(1, 3), 16);
  const fgG = parseInt(n.slice(3, 5), 16);
  const fgB = parseInt(n.slice(5, 7), 16);

  const bgR = parseInt(bg.slice(1, 3), 16);
  const bgG = parseInt(bg.slice(3, 5), 16);
  const bgB = parseInt(bg.slice(5, 7), 16);

  const r = Math.round(fgR * alpha + bgR * (1 - alpha)).toString(16).padStart(2, "0");
  const g = Math.round(fgG * alpha + bgG * (1 - alpha)).toString(16).padStart(2, "0");
  const b = Math.round(fgB * alpha + bgB * (1 - alpha)).toString(16).padStart(2, "0");

  return `#${r}${g}${b}`;
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

/** Frame the camera to the graph bounds with 25% padding. */
function fitCameraToGraph(s: Sigma, graph: Graph) {
  if (graph.order === 0) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  graph.forEachNode((_id, attrs) => {
    const x = attrs.x as number;
    const y = attrs.y as number;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const halfW = Math.max(1, (maxX - minX) / 2);
  const halfH = Math.max(1, (maxY - minY) / 2);
  const container = s.getContainer();
  const vw = container.clientWidth || 1;
  const vh = container.clientHeight || 1;
  const padding = 1.25;
  const probeA = s.viewportToGraph({ x: 0, y: 0 });
  const probeB = s.viewportToGraph({ x: vw, y: 0 });
  const graphUnitsPerViewportWidth = Math.abs(probeB.x - probeA.x);
  const wantedWidth = halfW * 2 * padding;
  const wantedHeight = halfH * 2 * padding;
  const cam = s.getCamera();
  const currentRatio = cam.ratio;
  const ratio =
    currentRatio *
    Math.max(
      wantedWidth / graphUnitsPerViewportWidth,
      (wantedHeight / graphUnitsPerViewportWidth) * (vw / vh),
    );
  const view = s.graphToViewport({ x: cx, y: cy });
  const framed = s.viewportToFramedGraph(view);
  cam.setState({ x: framed.x, y: framed.y, ratio, angle: 0 });
}
