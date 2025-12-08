export type NodeID = string;

export type NodeType = "concept" | "fact" | "source" | "question";

export interface ForestNode {
  id: NodeID;
  parentId: NodeID | null;
  title: string;
  content: string; // Markdown body
  type: NodeType;
  createdAt: number;
  
  // The Tree Structure
  children: NodeID[]; 
  
  // The Graph Structure (Cross-links)
  links: NodeID[]; 

}

export interface ForestState {
  nodes: Record<NodeID, ForestNode>; // The Flat Map
  rootNodeId: NodeID;
}
