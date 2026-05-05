/**
 * Per-topic graph pane. React Flow 12 (`@xyflow/react`).
 *
 * Layout: we reuse the d3-hierarchy result from the tree layout module
 * but rotate it horizontally (depth → x, sibling → y). React Flow then
 * renders rich DOM nodes — title + type chip — with native pointer
 * events, so hover/click/keyboard accessibility come for free.
 *
 * Edges:
 *   - parent edges (style: solid, forest-300) form the tree backbone
 *   - link edges (style: dashed, accent) come from `node.links` and
 *     express explicit cross-references; when `dst` lives outside this
 *     topic the edge is a dangling stub anchored at the source — we'll
 *     wire those into the unified view in P4.
 *
 * v1 lesson — we don't run a force simulation here. The deterministic
 * tree layout means hit-testing and animations are stable; the unified
 * view in P4 is where we'll bring in forces.
 */

import { useCallback, useEffect, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  type Edge,
  type Node as RFNode,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { cn } from "@/lib/cn";
import { useFocusNode } from "@/app/navigation";
import { useForestData } from "@/stores/forestData";
import { computeTreeLayout } from "@/features/tree/layout";
import type { NodeId, NodeType, TopicId } from "@/lib/types";

interface Props {
  topicId: TopicId;
  focusedNodeId: NodeId;
}

interface GraphNodeData extends Record<string, unknown> {
  title: string;
  nodeType: NodeType;
  focused: boolean;
}

const NODE_W = 180;
const NODE_H = 64;
// Horizontal layout — x advances by sibling, y by depth. computeTreeLayout
// returns vertical, so we swap the axes after the fact and pad.
const COLUMN_GAP = 220;
const ROW_GAP = 80;

const TYPE_GLYPH: Record<NodeType, string> = {
  concept: "C",
  fact: "F",
  source: "S",
  example: "E",
  question: "?",
  task: "T",
  misc: "·",
};

export function GraphView(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}

const nodeTypes = { topicNode: GraphNodeChip };

function GraphInner({ topicId, focusedNodeId }: Props) {
  const detail = useForestData((s) => s.topicDetails[topicId]);
  const fetchTopic = useForestData((s) => s.fetchTopic);
  const focus = useFocusNode();

  useEffect(() => {
    if (!detail) void fetchTopic(topicId).catch(() => {});
  }, [topicId, detail, fetchTopic]);

  const { nodes: laidNodes, edges: laidEdges } = useMemo(() => {
    if (!detail) return { nodes: [] as RFNode<GraphNodeData>[], edges: [] as Edge[] };
    const layout = computeTreeLayout({
      nodes: detail.nodes.map((n) => ({ id: n.id, parent: n.parent, title: n.title })),
      rootId: detail.root_node_id,
      collapsed: [],
      nodeWidth: ROW_GAP,
      nodeHeight: COLUMN_GAP,
    });
    // Map layout-space (vertical) to RF-space (horizontal). x_in is the
    // horizontal coordinate within siblings; y_in is depth*COLUMN_GAP.
    // RF coordinates are top-left of each node, so subtract half size.
    const rfNodes: RFNode<GraphNodeData>[] = layout.nodes.map((n) => {
      const summary = detail.nodes.find((s) => s.id === n.id);
      return {
        id: n.id,
        type: "topicNode",
        position: { x: n.y - NODE_W / 2, y: n.x - NODE_H / 2 },
        data: {
          title: summary?.title ?? n.title,
          nodeType: summary?.type ?? "misc",
          focused: n.id === focusedNodeId,
        },
        // Sized so React Flow's auto-fit knows the bounds.
        width: NODE_W,
        height: NODE_H,
        // Keep nodes immovable for now — drag-to-reparent is a P4 task.
        draggable: false,
        selectable: true,
      };
    });
    const treeEdges: Edge[] = layout.edges.map((e) => ({
      id: `tree:${e.source}->${e.target}`,
      source: e.source,
      target: e.target,
      type: "smoothstep",
      style: { stroke: "var(--color-forest-300, #b8c8be)", strokeWidth: 1.5 },
      // No marker — it's a containment relation, not a directed flow.
    }));
    // Link edges. Only render when the target id is also in this topic;
    // otherwise stash the (src, dst) pair on the source node so the
    // unified view can render the tail in P4. Avoid duplicate when both
    // endpoints declare the link (links are bidirectional in v1's model
    // — we keep the same convention).
    const local = new Set(detail.nodes.map((n) => n.id));
    const seen = new Set<string>();
    const linkEdges: Edge[] = [];
    for (const summary of detail.nodes) {
      for (const dst of summary.links) {
        if (!local.has(dst)) continue;
        const key = canonicalLinkKey(summary.id, dst);
        if (seen.has(key)) continue;
        seen.add(key);
        linkEdges.push({
          id: `link:${key}`,
          source: summary.id,
          target: dst,
          type: "straight",
          style: {
            stroke: "var(--color-accent, #d47a5d)",
            strokeWidth: 1.25,
            strokeDasharray: "4 4",
            opacity: 0.7,
          },
        });
      }
    }
    return { nodes: rfNodes, edges: [...treeEdges, ...linkEdges] };
  }, [detail, focusedNodeId]);

  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode<GraphNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Push the recomputed layout into RF state. We replace wholesale — RF
  // diff'ing handles re-render efficiency; our position values are
  // stable across renders unless the topic changes shape.
  useEffect(() => {
    setNodes(laidNodes);
    setEdges(laidEdges);
  }, [laidNodes, laidEdges, setNodes, setEdges]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: RFNode<GraphNodeData>) => {
      void focus(node.id, topicId);
    },
    [focus, topicId],
  );

  if (!detail) {
    return <div className="text-forest-400 flex h-full items-center justify-center text-sm">Loading…</div>;
  }
  if (laidNodes.length === 0) {
    return <div className="text-forest-400 flex h-full items-center justify-center text-sm">Empty topic.</div>;
  }

  return (
    <div className="h-full w-full">
      <ReactFlow<RFNode<GraphNodeData>, Edge>
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
        minZoom={0.2}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        // Keep panning on; disable selection box to avoid accidental
        // drags clearing focus.
        panOnDrag
        selectionOnDrag={false}
        panOnScroll={false}
        zoomOnScroll
        nodesDraggable={false}
        nodesConnectable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} className="opacity-40" />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function canonicalLinkKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function GraphNodeChip({ data }: { data: GraphNodeData }) {
  const { title, nodeType, focused } = data;
  return (
    <div
      className={cn(
        "shadow-glass border flex h-16 w-[180px] items-center gap-2 rounded-xl px-3 py-2 backdrop-blur-md transition-colors",
        focused
          ? "bg-forest-800 text-sand-100 border-accent"
          : "bg-sand-100/85 text-forest-700 border-forest-200 hover:border-forest-400",
      )}
      title={title}
    >
      {/* Hidden handles let the React Flow edges find anchor points
          without rendering visible dots — we want a clean DOM look. */}
      <Handle type="target" position={Position.Left} className="!h-1 !w-1 !border-0 !bg-transparent" />
      <Handle type="source" position={Position.Right} className="!h-1 !w-1 !border-0 !bg-transparent" />
      <span
        aria-hidden
        className={cn(
          "inline-flex h-7 w-7 flex-none items-center justify-center rounded-md text-xs font-semibold uppercase",
          focused ? "bg-sand-100/20 text-sand-100" : "bg-forest-100 text-forest-600",
        )}
      >
        {TYPE_GLYPH[nodeType]}
      </span>
      <span className="min-w-0 truncate text-sm font-medium">{title || "Untitled"}</span>
    </div>
  );
}
