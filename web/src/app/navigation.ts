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

import { useWorkspaceUI, type ForestCameraMode } from "@/stores/workspaceUI";
import type { NodeId, TopicId } from "@/lib/types";

interface FocusOptions {
  /** Replace history entry instead of pushing one. Use for redirects
      (e.g. landing on /$topicId nudging to /$topicId/$rootNodeId) so
      the redirect target doesn't pollute the back stack. */
  replace?: boolean;
  /** Forest view camera semantics for this navigation. Defaults to the concrete node. */
  forestCameraMode?: ForestCameraMode;
}

/**
 * Returns a stable `(nodeId, topicId, opts?) => Promise<void>` that
 * routes the webview to the editor for that node.
 *
 * On a non-replace push we also bump the workspaceUI nav counters so
 * the toolbar's Back / Forward affordances reflect the right edges.
 */
export function useFocusNode() {
  const navigate = useNavigate();
  const recordPush = useWorkspaceUI((s) => s.recordPush);
  const setForestCameraIntent = useWorkspaceUI((s) => s.setForestCameraIntent);
  return useCallback(
    async (nodeId: NodeId, topicId: TopicId, opts?: FocusOptions) => {
      const replace = opts?.replace ?? false;
      setForestCameraIntent({
        targetNodeId: nodeId,
        topicId,
        mode: opts?.forestCameraMode ?? "node",
      });
      const result = await navigate({
        to: "/$topicId/$nodeId",
        params: { topicId, nodeId },
        replace,
      });
      if (!replace) recordPush();
      return result;
    },
    [navigate, recordPush, setForestCameraIntent],
  );
}

/**
 * Browser-style history primitives.
 *
 * The cursor is tracked in `workspaceUI` (`navBack` / `navForward`)
 * because TanStack Router's `BrowserHistory` doesn't expose its index
 * and `window.history.length` counts entries from outside the SPA too.
 * Each `useFocusNode` push bumps `navBack`; back/forward swap a count
 * between the two sides. We clamp here too so a click at the edge is
 * a true no-op — no chance of falling out of the SPA's history range.
 */
export function useNav() {
  const router = useRouter();
  const navBack = useWorkspaceUI((s) => s.navBack);
  const navForward = useWorkspaceUI((s) => s.navForward);
  const recordBack = useWorkspaceUI((s) => s.recordBack);
  const recordForward = useWorkspaceUI((s) => s.recordForward);
  const back = useCallback(() => {
    if (navBack <= 0) return;
    recordBack();
    router.history.back();
  }, [navBack, recordBack, router]);
  const forward = useCallback(() => {
    if (navForward <= 0) return;
    recordForward();
    router.history.forward();
  }, [navForward, recordForward, router]);
  return {
    back,
    forward,
    canGoBack: navBack > 0,
    canGoForward: navForward > 0,
  } as const;
}
