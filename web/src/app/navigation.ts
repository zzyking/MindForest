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
 * these and disabled state is read from the same router state.
 */
export function useNav() {
  const router = useRouter();
  const back = useCallback(() => router.history.back(), [router]);
  const forward = useCallback(() => router.history.forward(), [router]);
  // TanStack Router's history exposes `length` and `index` so we can
  // derive can-go-back / can-go-forward without poking window.history.
  const canGoBack = router.history.length > 1 && (router.history as unknown as { index: number }).index > 0;
  const canGoForward =
    (router.history as unknown as { index: number }).index <
    router.history.length - 1;
  return { back, forward, canGoBack, canGoForward } as const;
}
