/**
 * Pure tree-layout computation. Lives in its own module so it can be
 * imported both from React-land (for SSR / testing / fallback) and from
 * a Web Worker without dragging in any DOM dependencies.
 *
 * Input is a flat list of `{id, parent}` summaries plus a set of node
 * ids that should be treated as "collapsed" (their descendants are
 * pruned from the layout). Output is `{x, y}` positions per visible
 * node plus the parent → child edges between them.
 *
 * Coordinate system: y grows downward (matches SVG and screen). The
 * tree is laid out top-down; a horizontal layout would be a 90° swap of
 * x/y — left as a future option.
 *
 * Sizing knobs: `nodeWidth` / `nodeHeight` are the bounding box
 * `d3.tree().nodeSize()` allocates per node; the renderer is free to
 * draw a smaller chip inside that box.
 */

import { hierarchy, tree as d3tree } from "d3-hierarchy";

export interface TreeInputNode {
  id: string;
  parent: string | null;
  title: string;
}

export interface TreeLayoutInput {
  nodes: TreeInputNode[];
  rootId: string;
  collapsed: string[];
  nodeWidth: number;
  nodeHeight: number;
}

export interface TreeLayoutNode {
  id: string;
  parent: string | null;
  title: string;
  x: number;
  y: number;
  /** Whether this subtree was pruned for being collapsed. */
  hasHiddenChildren: boolean;
  depth: number;
}

export interface TreeLayoutEdge {
  source: string;
  target: string;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

export interface TreeLayoutResult {
  nodes: TreeLayoutNode[];
  edges: TreeLayoutEdge[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

interface RawNode {
  id: string;
  parent: string | null;
  title: string;
  children: RawNode[];
  /** Was this node collapsed before pruning? */
  collapsed: boolean;
}

export function computeTreeLayout(input: TreeLayoutInput): TreeLayoutResult {
  const { nodes, rootId, collapsed, nodeWidth, nodeHeight } = input;
  const collapsedSet = new Set(collapsed);

  // Build adjacency once. Sort siblings by id (ULID is monotonic so this
  // matches creation order — matches the sidebar's ordering).
  const childrenByParent = new Map<string | null, TreeInputNode[]>();
  for (const n of nodes) {
    const arr = childrenByParent.get(n.parent) ?? [];
    arr.push(n);
    childrenByParent.set(n.parent, arr);
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => a.id.localeCompare(b.id));
  }

  // Walk from root, materialising a tree where collapsed nodes have no
  // visible children but remember the fact via `collapsed=true` so the
  // renderer can show an indicator. Returns null when the root is
  // missing — caller treats this as "empty".
  const root = (function build(id: string): RawNode | null {
    const node = nodes.find((n) => n.id === id);
    if (!node) return null;
    const isCollapsed = collapsedSet.has(id);
    const childSummaries = childrenByParent.get(id) ?? [];
    const children: RawNode[] = isCollapsed
      ? []
      : childSummaries
          .map((c) => build(c.id))
          .filter((c): c is RawNode => c !== null);
    return {
      id: node.id,
      parent: node.parent,
      title: node.title,
      children,
      collapsed: isCollapsed && childSummaries.length > 0,
    };
  })(rootId);

  if (!root) {
    return {
      nodes: [],
      edges: [],
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    };
  }

  const layout = d3tree<RawNode>().nodeSize([nodeWidth, nodeHeight]);
  const laid = layout(hierarchy<RawNode>(root, (d) => d.children));

  const outNodes: TreeLayoutNode[] = [];
  const outEdges: TreeLayoutEdge[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  laid.each((point) => {
    const x = point.x;
    const y = point.y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    outNodes.push({
      id: point.data.id,
      parent: point.data.parent,
      title: point.data.title,
      x,
      y,
      hasHiddenChildren: point.data.collapsed,
      depth: point.depth,
    });
  });

  laid.links().forEach((l) => {
    outEdges.push({
      source: l.source.data.id,
      target: l.target.data.id,
      sx: l.source.x,
      sy: l.source.y,
      tx: l.target.x,
      ty: l.target.y,
    });
  });

  return {
    nodes: outNodes,
    edges: outEdges,
    bounds: {
      minX: Number.isFinite(minX) ? minX : 0,
      maxX: Number.isFinite(maxX) ? maxX : 0,
      minY: Number.isFinite(minY) ? minY : 0,
      maxY: Number.isFinite(maxY) ? maxY : 0,
    },
  };
}
