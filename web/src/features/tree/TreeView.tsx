/**
 * Topic tree pane. Renders the focused topic's hierarchy as SVG with
 * one `<g>` per node. The layout is computed off-thread; this file is
 * pure presentation + interaction.
 *
 * Movement uses a CSS transition on the wrapper `<g>`'s transform. When
 * the layout updates, every existing node's `<g>` re-renders with new
 * `translate(x,y)` values — the browser tweens the property natively.
 * No springs, no `layoutId`, no shared transitions; just one CSS
 * property animating on each node. The cubic-bezier matches the v1
 * "calm" curve.
 *
 * Pan / zoom: simple homegrown camera (no d3-zoom). Pointer-down anywhere
 * on the canvas pans; wheel zooms anchored on the cursor. Stays in
 * tree-space so the renderer never measures the viewport.
 *
 * Resize behaviour: the SVG fills `main`, which is sized by CSS Grid.
 * When the sidebar opens/closes we recompute viewBox to keep the
 * focused node centred — but only on actual viewport size *change*,
 * not on every render — so nodes don't appear to drift in tree-space.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { useFocusNode } from "@/app/navigation";
import { useForestData } from "@/stores/forestData";
import type { NodeId, TopicId } from "@/lib/types";

import { useTreeLayout } from "./useTreeLayout";

interface Props {
  topicId: TopicId;
  focusedNodeId: NodeId;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 76;
const NODE_BOX_WIDTH = 180;
const NODE_BOX_HEIGHT = 48;

export function TreeView({ topicId, focusedNodeId }: Props) {
  const detail = useForestData((s) => s.topicDetails[topicId]);
  const fetchTopic = useForestData((s) => s.fetchTopic);
  const focus = useFocusNode();

  // Hydrate detail on mount / topic change. Idempotent.
  useEffect(() => {
    if (!detail) void fetchTopic(topicId).catch(() => {});
  }, [topicId, detail, fetchTopic]);

  // Collapse state — start with everything expanded so the user sees
  // the whole tree at first. Auto-expand ancestors of the focused node
  // so a fresh render doesn't hide where they are. Collapses persist
  // for the lifetime of this component (tab session).
  const [collapsed, setCollapsed] = useState<Set<NodeId>>(() => new Set());

  const layoutInput = useMemo(() => {
    if (!detail) return null;
    return {
      nodes: detail.nodes.map((n) => ({ id: n.id, parent: n.parent, title: n.title })),
      rootId: detail.root_node_id,
    };
  }, [detail]);

  const layout = useTreeLayout({
    nodes: layoutInput?.nodes ?? [],
    rootId: layoutInput?.rootId ?? null,
    collapsed,
    nodeWidth: NODE_WIDTH,
    nodeHeight: NODE_HEIGHT,
  });

  // Camera state — translate in tree-space + scale. The SVG transform
  // applies to a wrapper `<g>` so the node `<g>`s own positions stay in
  // raw layout space (good for FLIP).
  const [camera, setCamera] = useState({ x: 0, y: 0, k: 1 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  // Track whether the user has manually panned/zoomed; if not, we keep
  // re-centring on focus changes. Once they touch the canvas we leave
  // the camera alone.
  const userMovedRef = useRef(false);

  // Measure the viewport. ResizeObserver covers sidebar toggles, window
  // resize, and devtools snapping.
  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      setViewport({ width: rect.width, height: rect.height });
    });
    ro.observe(el);
    const rect = el.getBoundingClientRect();
    setViewport({ width: rect.width, height: rect.height });
    return () => ro.disconnect();
  }, []);

  // Centre the focused node in the viewport whenever it changes — but
  // only if the user hasn't taken over the camera. Auto-centre on first
  // load too.
  useEffect(() => {
    if (!layout || viewport.width === 0 || viewport.height === 0) return;
    if (userMovedRef.current) return;
    const focusedNode = layout.nodes.find((n) => n.id === focusedNodeId)
      ?? layout.nodes.find((n) => n.id === layoutInput?.rootId);
    if (!focusedNode) return;
    setCamera((prev) => ({
      x: viewport.width / 2 - focusedNode.x * prev.k,
      y: viewport.height / 3 - focusedNode.y * prev.k,
      k: prev.k,
    }));
  }, [layout, focusedNodeId, viewport.width, viewport.height, layoutInput?.rootId]);

  // Pointer-driven pan. Capture pointer so drags continue when the
  // cursor leaves the SVG (matches browser drag behaviour).
  const dragStateRef = useRef<{ x: number; y: number; cam: { x: number; y: number } } | null>(null);
  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    // Ignore drags that started on a node — let click bubble normally.
    if ((e.target as Element).closest("[data-node-id]")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      x: e.clientX,
      y: e.clientY,
      cam: { x: camera.x, y: camera.y },
    };
  }, [camera.x, camera.y]);
  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragStateRef.current;
    if (!drag) return;
    userMovedRef.current = true;
    setCamera((c) => ({ ...c, x: drag.cam.x + (e.clientX - drag.x), y: drag.cam.y + (e.clientY - drag.y) }));
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (dragStateRef.current) {
      e.currentTarget.releasePointerCapture(e.pointerId);
      dragStateRef.current = null;
    }
  }, []);

  // Wheel zoom anchored at the cursor: we want the point under the
  // cursor to stay fixed in tree-space across the zoom step.
  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    e.preventDefault();
    userMovedRef.current = true;
    const rect = svgRef.current.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setCamera((c) => {
      const factor = Math.exp(-e.deltaY * 0.0015);
      const nextK = Math.min(2.5, Math.max(0.25, c.k * factor));
      // Solve for new tx so that (cx - tx) / k stays constant.
      const treeX = (cx - c.x) / c.k;
      const treeY = (cy - c.y) / c.k;
      return {
        k: nextK,
        x: cx - treeX * nextK,
        y: cy - treeY * nextK,
      };
    });
  }, []);

  // Reset camera to the focused node + 1.0 zoom.
  const recenter = useCallback(() => {
    if (!layout || viewport.width === 0) return;
    const target = layout.nodes.find((n) => n.id === focusedNodeId)
      ?? layout.nodes.find((n) => n.id === layoutInput?.rootId);
    if (!target) return;
    userMovedRef.current = false;
    setCamera({ x: viewport.width / 2 - target.x, y: viewport.height / 3 - target.y, k: 1 });
  }, [layout, focusedNodeId, layoutInput?.rootId, viewport.width, viewport.height]);

  const toggleCollapsed = useCallback((id: NodeId) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (!detail) {
    return <div className="text-forest-400 flex h-full items-center justify-center text-sm">Loading…</div>;
  }
  if (!layout || layout.nodes.length === 0) {
    return <div className="text-forest-400 flex h-full items-center justify-center text-sm">Empty topic.</div>;
  }

  return (
    <div className="relative h-full w-full">
      <svg
        ref={svgRef}
        className="h-full w-full cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <g transform={`translate(${camera.x},${camera.y}) scale(${camera.k})`}>
          {layout.edges.map((edge) => (
            <TreeEdge key={`${edge.source}->${edge.target}`} edge={edge} />
          ))}
          {layout.nodes.map((node) => (
            <TreeNode
              key={node.id}
              id={node.id}
              x={node.x}
              y={node.y}
              title={node.title}
              focused={node.id === focusedNodeId}
              hasHiddenChildren={node.hasHiddenChildren}
              onClick={() => void focus(node.id, topicId)}
              onToggle={() => toggleCollapsed(node.id)}
            />
          ))}
        </g>
      </svg>
      <div className="absolute bottom-4 right-4 flex items-center gap-2">
        <button
          type="button"
          onClick={recenter}
          className="border-forest-200 bg-sand-100/80 text-forest-600 hover:text-forest-800 rounded-full border px-3 py-1 text-xs backdrop-blur-md"
        >
          Recenter
        </button>
      </div>
    </div>
  );
}

interface TreeNodeProps {
  id: string;
  x: number;
  y: number;
  title: string;
  focused: boolean;
  hasHiddenChildren: boolean;
  onClick: () => void;
  onToggle: () => void;
}

function TreeNode({ id, x, y, title, focused, hasHiddenChildren, onClick, onToggle }: TreeNodeProps) {
  return (
    <g
      data-node-id={id}
      style={{
        transform: `translate(${x}px,${y}px)`,
        transition: "transform 320ms cubic-bezier(.2,.8,.2,1)",
      }}
    >
      <rect
        x={-NODE_BOX_WIDTH / 2}
        y={-NODE_BOX_HEIGHT / 2}
        width={NODE_BOX_WIDTH}
        height={NODE_BOX_HEIGHT}
        rx={10}
        ry={10}
        className={cn(
          "cursor-pointer transition-colors",
          focused
            ? "fill-forest-800 stroke-accent"
            : "fill-sand-100 stroke-forest-200 hover:stroke-forest-400",
        )}
        strokeWidth={focused ? 2 : 1}
        onClick={onClick}
      />
      <text
        x={0}
        y={4}
        textAnchor="middle"
        className={cn(
          "pointer-events-none select-none text-[12px] font-medium",
          focused ? "fill-sand-100" : "fill-forest-700",
        )}
      >
        {truncate(title || "Untitled", 22)}
      </text>
      {hasHiddenChildren && (
        <g
          transform={`translate(0,${NODE_BOX_HEIGHT / 2 + 8})`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="cursor-pointer"
        >
          <circle r={8} className="fill-forest-100 stroke-forest-300" strokeWidth={1} />
          <text textAnchor="middle" y={3} className="fill-forest-700 select-none text-[10px]">
            +
          </text>
        </g>
      )}
    </g>
  );
}

function TreeEdge({ edge }: { edge: { sx: number; sy: number; tx: number; ty: number } }) {
  // Smooth cubic between the bottom of the source and the top of the
  // target box. Control points placed mid-way vertically for an
  // S-curve that stays inside the column.
  const sy = edge.sy + NODE_BOX_HEIGHT / 2;
  const ty = edge.ty - NODE_BOX_HEIGHT / 2;
  const midY = (sy + ty) / 2;
  const d = `M ${edge.sx},${sy} C ${edge.sx},${midY} ${edge.tx},${midY} ${edge.tx},${ty}`;
  return (
    <path
      d={d}
      className="fill-none stroke-forest-200"
      strokeWidth={1.25}
      style={{ transition: "d 320ms cubic-bezier(.2,.8,.2,1)" }}
    />
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
