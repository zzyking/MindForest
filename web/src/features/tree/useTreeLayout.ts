/**
 * React hook that owns a single TreeWorker instance for its caller and
 * drops stale results.
 *
 * Behaviour:
 * - Posts a fresh layout request whenever any of `nodes` / `rootId` /
 *   `collapsed` change.
 * - Each request gets a monotonically increasing id; replies from
 *   earlier ids are ignored. (Matters because we may post a new request
 *   before the previous one comes back.)
 * - Falls back to running the layout synchronously if Worker isn't
 *   available (SSR, or older Safari that strangles module workers).
 *   The layout function is the same import either way, so behaviour is
 *   identical apart from where it runs.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  computeTreeLayout,
  type TreeInputNode,
  type TreeLayoutInput,
  type TreeLayoutResult,
} from "./layout";
import type { OutboundMessage } from "./treeWorker";
// Vite-specific worker constructor. `?worker` returns a class that
// instantiates the bundled worker as a module worker.
import TreeWorker from "./treeWorker?worker";

interface Options {
  nodes: TreeInputNode[];
  rootId: string | null;
  collapsed: Set<string>;
  nodeWidth: number;
  nodeHeight: number;
}

export function useTreeLayout({
  nodes,
  rootId,
  collapsed,
  nodeWidth,
  nodeHeight,
}: Options): TreeLayoutResult | null {
  const [result, setResult] = useState<TreeLayoutResult | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const lastReqIdRef = useRef(0);
  const lastSeenIdRef = useRef(0);

  useEffect(() => {
    if (typeof Worker === "undefined") return;
    let worker: Worker;
    try {
      // Vite resolves `?worker` to a Worker constructor.
      worker = new TreeWorker();
    } catch {
      return;
    }
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<OutboundMessage>) => {
      const { id, result, error } = e.data;
      // Drop replies older than the most recently *consumed* id.
      if (id <= lastSeenIdRef.current) return;
      lastSeenIdRef.current = id;
      if (error) {
        // eslint-disable-next-line no-console
        console.warn("[treeWorker] layout error:", error);
        return;
      }
      if (result) setResult(result);
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Memo the input so we don't repost on unrelated re-renders. We hash
  // by node id+title+parent so renames trigger a relayout (titles affect
  // collision sizing if we later add measured widths) but unrelated
  // updates (e.g. content edits) don't.
  const stableInput = useMemo<TreeLayoutInput | null>(() => {
    if (!rootId) return null;
    return {
      nodes: nodes.map((n) => ({ id: n.id, parent: n.parent, title: n.title })),
      rootId,
      collapsed: Array.from(collapsed).sort(),
      nodeWidth,
      nodeHeight,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rootId,
    nodeWidth,
    nodeHeight,
    // Cheap structural fingerprint — only enough to invalidate when the
    // tree shape or labels change. Avoid `JSON.stringify(nodes)` since
    // it'd allocate every render.
    nodes.length,
    nodes.map((n) => `${n.id}:${n.parent ?? ""}:${n.title}`).join("|"),
    Array.from(collapsed).sort().join("|"),
  ]);

  useEffect(() => {
    if (!stableInput) {
      setResult(null);
      return;
    }
    lastReqIdRef.current += 1;
    const id = lastReqIdRef.current;
    if (workerRef.current) {
      workerRef.current.postMessage({ id, input: stableInput });
      return;
    }
    // Fallback: run on the main thread.
    try {
      const r = computeTreeLayout(stableInput);
      lastSeenIdRef.current = id;
      setResult(r);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[useTreeLayout] sync fallback error:", e);
    }
  }, [stableInput]);

  return result;
}
