/**
 * Debounced save with two correctness guarantees v1 violated:
 *
 * 1. **No cross-node spillover.** If the user edits node A, navigates
 *    to node B before the 300 ms timer fires, and the timer then
 *    triggers, the pending payload is written to A — not to whatever
 *    node is currently focused. We capture `targetId` at *queue time*
 *    and pass it through to the save fn.
 *
 * 2. **Flush on focus change & unmount.** The hook returns `flush()`,
 *    which the caller invokes immediately before navigation or
 *    `useEffect` cleanup. Without this, a fast back/forward sequence
 *    can drop the most recent edit.
 *
 * Errors are surfaced via the optional `onError` callback so the host
 * component can decide whether to toast, retry, or revert.
 */

import { useCallback, useEffect, useRef } from "react";

interface PendingSave<T> {
  targetId: string;
  payload: T;
  // Resolves on the same tick the save eventually runs (success or fail).
  // Useful so flush() can await the in-flight write before navigating.
  done: Promise<void>;
  resolveDone: () => void;
}

interface Options<T> {
  delayMs?: number;
  onError?: (err: unknown, targetId: string, payload: T) => void;
}

/**
 * `save(targetId, payload)` is the idempotent write. The hook ensures
 * we never lose the latest payload for a given targetId, even across
 * rapid keystrokes; intermediate payloads are coalesced.
 */
export function useDebouncedSave<T>(
  save: (targetId: string, payload: T) => Promise<unknown>,
  { delayMs = 300, onError }: Options<T> = {},
) {
  const pendingRef = useRef<PendingSave<T> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Save fn captured via ref so changing identity (e.g. fresh closure
  // each render) doesn't disturb in-flight saves.
  const saveRef = useRef(save);
  saveRef.current = save;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const runSave = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    try {
      await saveRef.current(pending.targetId, pending.payload);
    } catch (e) {
      onErrorRef.current?.(e, pending.targetId, pending.payload);
    } finally {
      pending.resolveDone();
    }
  }, []);

  const queue = useCallback(
    (targetId: string, payload: T): Promise<void> => {
      // If a previous queue is for a different node, flush it now so
      // its write happens against the correct id. The user navigated
      // before the timer fired; we honor the prior edit before queueing
      // the new one.
      const prev = pendingRef.current;
      if (prev && prev.targetId !== targetId) {
        // Run synchronously enough that we won't double-up; the await
        // inside runSave still gives the network call time to complete.
        void runSave();
      }
      let resolveDone: () => void = () => {};
      const done = new Promise<void>((res) => {
        resolveDone = res;
      });
      pendingRef.current = { targetId, payload, done, resolveDone };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void runSave();
      }, delayMs);
      return done;
    },
    [delayMs, runSave],
  );

  const flush = useCallback((): Promise<void> => {
    const pending = pendingRef.current;
    if (!pending) return Promise.resolve();
    void runSave();
    return pending.done;
  }, [runSave]);

  // Best-effort flush on unmount. The promise we await is fire-and-forget
  // — by the time React tears the component down, the write is in flight.
  useEffect(() => {
    return () => {
      void flush();
    };
  }, [flush]);

  return { queue, flush } as const;
}
