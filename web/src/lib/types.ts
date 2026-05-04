/**
 * TypeScript mirrors of the Rust `domain` types, kept in sync by hand
 * against `rust/crates/domain/src/lib.rs`. The serialization is direct
 * JSON, so what we declare here must match the on-the-wire shape.
 *
 * Notes on field names:
 * - `Node.node_type` is wire-named `type` (serde rename). React props
 *   that take `type` as a name conflict with HTML, so callers usually
 *   destructure into `nodeType`.
 */

export type NodeId = string; // 26-char ULID
export type TopicId = string; // slug

export type NodeType =
  | "concept"
  | "fact"
  | "source"
  | "example"
  | "question"
  | "task"
  | "misc";

export interface Node {
  id: NodeId;
  topic: TopicId;
  parent: NodeId | null;
  type: NodeType;
  title: string;
  content: string;
  links: NodeId[];
  created_at: string; // ISO 8601 RFC3339
  updated_at: string;
  color?: string | null;
}

export interface NodeSummary {
  id: NodeId;
  parent: NodeId | null;
  type: NodeType;
  title: string;
  links: NodeId[];
  updated_at: string;
}

export interface Topic {
  id: TopicId;
  title: string;
  root_node_id: NodeId;
  bulletin: string;
  created_at: string;
  updated_at: string;
}

export interface TopicSummary {
  id: TopicId;
  title: string;
  node_count: number;
  updated_at: string;
}

export interface TopicDetail extends Topic {
  nodes: NodeSummary[];
}

export interface NewTopic {
  title: string;
  slug?: string;
}

export interface NewNode {
  topic: TopicId;
  parent: NodeId | null;
  title: string;
  content?: string;
  node_type?: NodeType;
}

export interface NodePatch {
  title?: string;
  content?: string;
  links?: NodeId[];
  type?: NodeType;
}

export interface SearchHit {
  id: NodeId;
  topic: TopicId;
  title: string;
  /** May contain `<b>...</b>` highlight markers from FTS5 snippet. */
  snippet: string;
  score: number;
}

export interface IndexStatus {
  embed_pending: number;
  fts_dirty: boolean;
  last_scan: string | null;
  embed_available: boolean;
}

export interface ApiErrorBody {
  error: string;
  message: string;
}
