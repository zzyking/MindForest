/**
 * Navigation hooks.
 *
 * The router (TanStack Router) is the single source of truth for which
 * node is focused — the URL `/$topicId/$nodeId` *is* the focus. These
 * hooks are the canonical way for components to move focus or step
 * through history; never call `useNavigate` directly outside this file
 * because (a) we want one consistent param shape and (b) we need to
 * keep the back/forward affordances honest as the route schema evolves.
 */

import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import type { NodeId, TopicId } from "@/lib/types";

interface FocusOptions {
  /** Replace history entry instead of pushing one. Use for redirects
      (e.g. landing on /$topicId nudging to /$topicId/$rootNodeId) so
      the redirect target doesn't pollute the back stack. */
  replace?: boolean;
}

/**
 * Returns a stable `(nodeId, topicId, opts?) => Promise<void>` that
 * routes the webview to the editor for that node.
 */
export function useFocusNode() {
  const navigate = useNavigate();
  return useCallback(
    (nodeId: NodeId, topicId: TopicId, opts?: FocusOptions) =>
      navigate({
        to: "/$topicId/$nodeId",
        params: { topicId, nodeId },
        replace: opts?.replace ?? false,
      }),
    [navigate],
  );
}

/**
 * Browser-style history primitives. Buttons can be wired straight to
 * these.
 *
 * `canGoBack` / `canGoForward` are intentionally always `true` here.
 * TanStack Router 1.x's `BrowserHistory` does not expose the cursor
 * index — the previous attempt to read `(router.history as { index }).index`
 * always returned `undefined`, so both flags were permanently `false`
 * and the buttons stayed disabled forever. `window.history` API also
 * doesn't expose "can-go-back" — the closest signals (`length`,
 * `state`) are unreliable. We delegate to `router.history.back()` /
 * `forward()` which no-op gracefully at history edges, so an
 * always-enabled button is correct: clicking at the edge does nothing
 * which is the same as clicking a disabled button.
 *
 * Trade-off: the affordance for "no further history" is weaker — but
 * for a knowledge tool where the user is constantly hopping between
 * nodes, the previous always-disabled state was the worse end of that
 * trade-off.
 */
export function useNav() {
  const router = useRouter();
  const back = useCallback(() => router.history.back(), [router]);
  const forward = useCallback(() => router.history.forward(), [router]);
  return { back, forward, canGoBack: true, canGoForward: true } as const;
}
