/**
 * Web Worker wrapper around `computeTreeLayout`. The layout itself is
 * fast (≤5 ms for ~1k nodes) but doing it off the main thread keeps the
 * UI responsive while the user is mid-keystroke and a topic detail
 * update happens to land at the same time.
 *
 * Message protocol:
 *   in:  { id: number, input: TreeLayoutInput }
 *   out: { id: number, result: TreeLayoutResult } | { id, error: string }
 *
 * The id pairs requests with replies so we can drop stale results.
 */

import { computeTreeLayout, type TreeLayoutInput, type TreeLayoutResult } from "./layout";

interface InboundMessage {
  id: number;
  input: TreeLayoutInput;
}

export interface OutboundMessage {
  id: number;
  result?: TreeLayoutResult;
  error?: string;
}

self.onmessage = (e: MessageEvent<InboundMessage>) => {
  const { id, input } = e.data;
  try {
    const result = computeTreeLayout(input);
    const reply: OutboundMessage = { id, result };
    (self as unknown as Worker).postMessage(reply);
  } catch (err) {
    const reply: OutboundMessage = { id, error: err instanceof Error ? err.message : String(err) };
    (self as unknown as Worker).postMessage(reply);
  }
};
