/**
 * Thin fetch wrapper around the Rust `/v1` HTTP API.
 *
 * Design choices worth knowing:
 * - All non-2xx responses throw an `ApiError` carrying the parsed
 *   `{error, message}` body when present, so callers can branch on
 *   `err.code === "not_found"` without repeating shape checks.
 * - `204 No Content` is normalized to `void`.
 * - Base URL is read once at module init from `VITE_API_BASE`, falling
 *   back to `127.0.0.1:8787` (the dev binary default). The Tauri shell
 *   sets it via window inject, but we read `import.meta.env` here for
 *   plain `npm run dev`.
 */

import type {
  ApiErrorBody,
  DownloadEvent,
  IndexStatus,
  ModelStatusResponse,
  NewNode,
  NewTopic,
  Node,
  NodeId,
  NodePatch,
  SearchHit,
  Topic,
  TopicDetail,
  TopicId,
  TopicSummary,
} from "./types";

// Resolution order (first hit wins):
// 1. `window.__MINDFOREST_API_BASE__` — Tauri shell injects this via an
//    initialization script with the OS-assigned in-process port.
// 2. `import.meta.env.VITE_API_BASE` — explicit override for `npm run dev`.
// 3. `http://127.0.0.1:8787` — the dev binary's default address.
const BASE = (
  (typeof window !== "undefined" && window.__MINDFOREST_API_BASE__) ||
  import.meta.env.VITE_API_BASE ||
  "http://127.0.0.1:8787"
).replace(/\/$/, "");

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${BASE}${path}`;
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const resp = await fetch(url, { ...init, headers });
  if (resp.status === 204) {
    return undefined as T;
  }
  if (!resp.ok) {
    let body: Partial<ApiErrorBody> = {};
    try {
      body = (await resp.json()) as ApiErrorBody;
    } catch {
      // Non-JSON error body — fall back to status text.
    }
    throw new ApiError(
      resp.status,
      body.error ?? `http_${resp.status}`,
      body.message ?? resp.statusText,
    );
  }
  return (await resp.json()) as T;
}

// ─── Health ─────────────────────────────────────────────────────────

export function getHealth(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/health");
}

// ─── Topics ─────────────────────────────────────────────────────────

export function listTopics(): Promise<TopicSummary[]> {
  return request<TopicSummary[]>("/v1/topics");
}

export function createTopic(input: NewTopic): Promise<Topic> {
  return request<Topic>("/v1/topics", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getTopic(id: TopicId): Promise<TopicDetail> {
  return request<TopicDetail>(`/v1/topics/${encodeURIComponent(id)}`);
}

export function deleteTopic(id: TopicId): Promise<void> {
  return request<void>(`/v1/topics/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ─── Nodes ──────────────────────────────────────────────────────────

export function getNode(id: NodeId): Promise<Node> {
  return request<Node>(`/v1/nodes/${encodeURIComponent(id)}`);
}

export function createNode(input: NewNode): Promise<Node> {
  return request<Node>("/v1/nodes", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateNode(id: NodeId, patch: NodePatch): Promise<Node> {
  return request<Node>(`/v1/nodes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteNode(id: NodeId): Promise<void> {
  return request<void>(`/v1/nodes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ─── Search ─────────────────────────────────────────────────────────

export interface SearchParams {
  q: string;
  topic?: TopicId;
  k?: number;
}

export function search(params: SearchParams): Promise<SearchHit[]> {
  const qs = new URLSearchParams({ q: params.q });
  if (params.topic) qs.set("topic", params.topic);
  if (params.k) qs.set("k", String(params.k));
  return request<SearchHit[]>(`/v1/search?${qs.toString()}`);
}

// ─── Index admin ────────────────────────────────────────────────────

export function getIndexStatus(): Promise<IndexStatus> {
  return request<IndexStatus>("/v1/index/status");
}

export function rebuildIndex(): Promise<void> {
  return request<void>("/v1/index/rebuild", { method: "POST" });
}

// ─── Embed model ────────────────────────────────────────────────────

export function getModelStatus(): Promise<ModelStatusResponse> {
  return request<ModelStatusResponse>("/v1/embed/model/status");
}

/**
 * Stream the EmbeddingGemma download. The server sends Server-Sent
 * Events (POST endpoint, so we use `fetch` + a manual SSE parser rather
 * than EventSource — EventSource is GET-only).
 *
 * Returns an async iterator that yields one `DownloadEvent` per server
 * event. The caller can stop early by calling the returned `cancel()`.
 *
 * Error model:
 * - Network/HTTP failures throw from the initial `fetch`.
 * - Server-emitted errors arrive as `{ kind: "error", message }` events
 *   followed by stream close. The iterator handles this naturally.
 * - Aborting via `cancel()` closes the underlying fetch — the server's
 *   `mpsc::UnboundedSender` is dropped and the download task tears down
 *   in O(1).
 */
export function downloadModel(
  signal?: AbortSignal,
): { events: AsyncIterable<DownloadEvent>; cancel: () => void } {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const events = consumeSseStream(controller.signal);
  return { events, cancel: () => controller.abort() };
}

async function* consumeSseStream(
  signal: AbortSignal,
): AsyncGenerator<DownloadEvent, void, void> {
  const resp = await fetch(`${BASE}/v1/embed/model/download`, {
    method: "POST",
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!resp.ok || !resp.body) {
    throw new ApiError(
      resp.status,
      `http_${resp.status}`,
      `download stream failed: ${resp.statusText}`,
    );
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are terminated by a blank line (`\n\n`). The server
      // may send `\r\n\r\n` on some proxies; handle both.
      let idx;
      while ((idx = nextFrameBoundary(buffer)) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^(\r?\n){1,2}/, "");
        const ev = parseSseFrame(frame);
        if (ev) yield ev;
      }
    }
  } finally {
    // Make the abort visible to the runtime even when the consumer
    // didn't explicitly call cancel — generators that exit early via
    // `break` route through this finally.
    reader.cancel().catch(() => {});
  }
}

function nextFrameBoundary(s: string): number {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function parseSseFrame(frame: string): DownloadEvent | null {
  // Minimal SSE parser: event lines start with `event:`, data lines with
  // `data:`. Comments (`:`) and `id:` are ignored. We only care about
  // the JSON `data:` payload — the variant is already in the payload's
  // `kind` field, so we can drop the `event:` line.
  let data = "";
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      data += line.slice(5).trimStart();
    }
  }
  if (!data) return null;
  try {
    return JSON.parse(data) as DownloadEvent;
  } catch {
    return null;
  }
}
