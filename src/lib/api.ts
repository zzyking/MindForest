const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:8787';

export type NodeType =
  | 'concept'
  | 'fact'
  | 'source'
  | 'example'
  | 'question'
  | 'task'
  | 'misc';

export interface NodeMetadata {
  node_type: NodeType;
  created_at: number;
  updated_at: number;
  color?: string;
}

export interface KnowledgeNode {
  id: string;
  title: string;
  content: string;
  parent: string | null;
  children: string[];
  links: string[];
  metadata: NodeMetadata;
}

export interface TopicSummary {
  id: string;
  title: string;
}

export interface Topic {
  id: string;
  title: string;
  root_node_id: string;
  nodes: Record<string, KnowledgeNode>;
  bulletin: string;
  version: number;
  layout: {
    tree_layout: 'binary' | 'n-ary' | 'pythagorean';
  };
}

export interface Health {
  ok: boolean;
}

export interface CreateTopicRequest {
  title: string;
}

export interface CreateNodeRequest {
  id?: string;
  title: string;
  content?: string;
  parent?: string | null;
  node_type?: NodeType;
}

export interface UpdateNodeRequest {
  title?: string;
  content?: string;
  links?: string[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }

  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<Health>('/health'),
  listTopics: () => request<TopicSummary[]>('/topics'),
  getTopic: (id: string) => request<Topic>(`/topics/${id}`),
  createTopic: (payload: CreateTopicRequest) =>
    request<Topic>('/topics', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  addNode: (topicId: string, payload: CreateNodeRequest) =>
    request<Topic>(`/topics/${topicId}/nodes`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateNode: (topicId: string, nodeId: string, payload: UpdateNodeRequest) =>
    request<Topic>(`/topics/${topicId}/nodes/${nodeId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteNode: (topicId: string, nodeId: string) =>
    request<Topic>(`/topics/${topicId}/nodes/${nodeId}`, {
      method: 'DELETE',
    }),
};
