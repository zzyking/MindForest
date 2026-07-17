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
  | "idea"
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
  /** Reparent. Server rejects cycles, cross-topic moves, and root reparenting. */
  parent?: NodeId;
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

// ─── Embed model status / download ──────────────────────────────────

export interface ModelFileStatus {
  name: string;
  present: boolean;
  size: number | null;
  /**
   * Bytes already in `<name>.partial` from a prior interrupted attempt.
   * `null` when the file isn't mid-flight (either complete or untouched).
   * Lets the UI render "Resume" vs. "Download" and seed the progress bar.
   */
  partial_size: number | null;
}

/** Server reply for `GET /v1/embed/model/status`. */
export interface ModelStatusResponse {
  repo_id: string;
  /** Absolute path on disk where the files live (or would live). */
  dir: string;
  present: boolean;
  files: ModelFileStatus[];
  /** "off" / "stub" / "sidecar" — which embedder backend is active. */
  embed_mode: "off" | "stub" | "sidecar";
}

/** SSE events emitted by `POST /v1/embed/model/download`. */
export type DownloadEvent =
  | { kind: "started"; repo_id: string; total_files: number }
  | { kind: "file_start"; name: string; size: number | null }
  | {
      kind: "progress";
      name: string;
      bytes_so_far: number;
      file_total: number | null;
      overall_so_far: number;
      overall_total: number | null;
    }
  | { kind: "file_done"; name: string; size: number }
  | { kind: "done" }
  | { kind: "error"; message: string };

// ─── Agent ──────────────────────────────────────────────────────────

/**
 * `client_id` placeholder if the proposal references a not-yet-applied
 * AddNode. ULID otherwise.
 */
export type NodeRef = string;

export type AgentProposal =
  | {
      op: "add_node";
      client_id?: string;
      parent: NodeRef;
      title: string;
      content?: string;
      type?: NodeType;
    }
  | {
      op: "update_node";
      id: NodeId;
      title?: string;
      content?: string;
      type?: NodeType;
    }
  | { op: "delete_node"; id: NodeId }
  | { op: "link"; from: NodeRef; to: NodeRef }
  | { op: "unlink"; from: NodeId; to: NodeId };

/** One shadow journal entry (H3 write tool). Mirrors agent `StagedOp`. */
export type StagedOp =
  | { op: "create_node"; node: Node }
  | { op: "patch_node"; before: Node; after: Node }
  | { op: "link_nodes"; src_id: NodeId; dst_id: NodeId; after: Node }
  | { op: "move_subtree"; before: Node; after: Node };

/** SSE events emitted by `POST /v1/agent/propose`. */
export type AgentEvent =
  | { kind: "token"; text: string }
  | { kind: "proposal"; proposal: AgentProposal }
  | { kind: "tool_call_pending"; id: string; name: string; input: unknown }
  | {
      kind: "tool_result";
      id: string;
      name: string;
      content: string;
      is_error: boolean;
    }
  | {
      kind: "staged_diff";
      turn_id: string;
      tool_call_id: string;
      op: StagedOp;
    }
  | { kind: "turn_started"; turn_id: string }
  | { kind: "error"; message: string }
  | { kind: "done" };

export interface AcceptStagedResponse {
  turn_id: string;
  applied: number;
  ops: StagedOp[];
}

export interface RejectStagedResponse {
  turn_id: string;
  discarded: number;
}

export interface AgentStatusResponse {
  /** Human-readable backend label, e.g. `"stub"`, `"gpt-4o-mini (api.openai.com)"`. */
  backend: string;
}

/** Persisted agent settings. Mirrors `app_core::AgentConfig`. */
export type AgentProvider = "auto" | "stub" | "openai" | "anthropic";

/**
 * What `GET /v1/agent/config` returns. The plaintext `api_key` never
 * crosses the wire — instead we get a boolean + a fingerprint. The UI
 * uses these to render the SecretField in its three states (unset,
 * locked-with-hint, or editing).
 */
export interface AgentOpenAIConfigView {
  base_url: string | null;
  model: string | null;
  api_key_set: boolean;
  api_key_hint: string | null;
}

export interface AgentAnthropicConfigView {
  model: string | null;
  api_key_set: boolean;
  api_key_hint: string | null;
}

export interface AgentConfigView {
  provider: AgentProvider;
  openai: AgentOpenAIConfigView;
  anthropic: AgentAnthropicConfigView;
}

/**
 * What `PUT /v1/agent/config` accepts. `api_key` is **triple-state**:
 *
 * - omit the field → keep the existing keychain entry
 * - `null` → clear the entry
 * - string → set a new value
 *
 * Other fields are whole-value replacements. `undefined` here means
 * "omit from the JSON" because `JSON.stringify` drops undefined values
 * — that's the encoding the server's `deserialize_optional_field`
 * helper reads as `None`.
 */
export interface AgentOpenAIConfigUpdate {
  base_url?: string | null;
  model?: string | null;
  api_key?: string | null;
}

export interface AgentAnthropicConfigUpdate {
  model?: string | null;
  api_key?: string | null;
}

export interface AgentConfigUpdate {
  provider: AgentProvider;
  openai: AgentOpenAIConfigUpdate;
  anthropic: AgentAnthropicConfigUpdate;
}

export interface AgentTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ProposeRequestBody {
  topic_id: TopicId;
  focused_node_id?: NodeId | null;
  prompt: string;
  /** Earlier turns of this conversation. Empty for a fresh chat. */
  history?: AgentTurn[];
}
