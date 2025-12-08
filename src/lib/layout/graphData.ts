import { ForestNode } from '@/types/forest';

export interface GraphDataNode {
  id: string;
  name: string;
  val: number;
}

export interface GraphDataLink {
  source: string;
  target: string;
  type: 'hierarchy' | 'semantic';
}

export interface GraphData {
  nodes: GraphDataNode[];
  links: GraphDataLink[];
}

export function buildGraphData(nodes: Record<string, ForestNode>): GraphData {
  const gNodes: GraphDataNode[] = [];
  const gLinks: GraphDataLink[] = [];
  const seen = new Set<string>();

  Object.values(nodes).forEach((node) => {
    gNodes.push({
      id: node.id,
      name: node.title,
      val: 1
    });

    node.children.forEach((childId) => {
      if (!nodes[childId]) return;
      const key = `hierarchy:${node.id}->${childId}`;
      if (!seen.has(key)) {
        gLinks.push({ source: node.id, target: childId, type: 'hierarchy' });
        seen.add(key);
      }
    });

    node.links?.forEach((targetId) => {
      if (!nodes[targetId]) return;
      const [a, b] = [node.id, targetId].sort();
      const key = `semantic:${a}-${b}`;
      if (!seen.has(key)) {
        gLinks.push({ source: node.id, target: targetId, type: 'semantic' });
        seen.add(key);
      }
    });
  });

  return { nodes: gNodes, links: gLinks };
}
