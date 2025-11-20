export type NodeID = string;

export type NodeType = "concept" | "fact" | "source" | "question";

export interface ForestNode {
  id: NodeID;
  parentId: NodeID | null;
  title: string;
  content: string; // Markdown body
  type: NodeType;
  
  // The Tree Structure
  children: NodeID[]; 
  
  // The Graph Structure (Cross-links)
  links: NodeID[]; 
  
  // Visual metadata (persisted)
  position?: { x: number; y: number }; // For graph view or manual layout
  color?: string;
  createdAt: number;
}

export interface ForestState {
  nodes: Record<NodeID, ForestNode>; // The Flat Map
  rootNodeId: NodeID;
}
