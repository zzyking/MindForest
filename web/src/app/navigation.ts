/**
 * Navigation hooks.
 *
 * The router (TanStack Router) is the single source of truth for which
 * node is focused — the URL `/$topicId/$nodeId` *is* the focus. Inspect
 * open state lives in `?w=1` on that same route (not in workspaceUI).
 * These hooks are the canonical way for components to move focus or
 * open/close Inspect; never call `useNavigate` directly outside this
 * file.
 */

import { useNavigate, useParams, useRouter, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

import { useWorkspaceUI, type ForestCameraMode } from "@/stores/workspaceUI";
import type { NodeId, TopicId } from "@/lib/types";

export interface FocusOptions {
  /** Replace history entry instead of pushing one. Use for redirects
      (e.g. landing on /$topicId nudging to /$topicId/$rootNodeId) so
      the redirect target doesn't pollute the back stack. */
  replace?: boolean;
  /** Forest view camera semantics for this navigation. Defaults to the concrete node. */
  forestCameraMode?: ForestCameraMode;
  /**
   * Inspect open flag (`?w=1`).
   * - `true`  → open Inspect on the focused node
   * - `false` → close Inspect (clear `w`)
   * - omit    → leave current `w` unchanged (e.g. breadcrumb while writing)
   */
  write?: boolean;
}

type NodeSearch = { w?: true };

function resolveSearch(
  prev: NodeSearch,
  write: boolean | undefined,
): NodeSearch {
  if (write === true) return { w: true };
  if (write === false) return {};
  return prev.w ? { w: true } : {};
}

/**
 * Returns a stable `(nodeId, topicId, opts?) => Promise<void>` that
 * routes to the given node. Pass `{ write: true }` to open Inspect.
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
        search: (prev: NodeSearch) => resolveSearch(prev, opts?.write),
        replace,
      });
      if (!replace) recordPush();
      return result;
    },
    [navigate, recordPush, setForestCameraIntent],
  );
}

/** Whether Inspect is open on the current node route (`?w=1`). */
export function useInspectOpen(): boolean {
  const search = useSearch({ strict: false }) as NodeSearch;
  return search.w === true;
}

/** Open Inspect on the currently focused node (sets `?w=1`, replace). */
export function useOpenInspect() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as {
    topicId?: TopicId;
    nodeId?: NodeId;
  };
  return useCallback(() => {
    if (!params.topicId || !params.nodeId) return;
    void navigate({
      to: "/$topicId/$nodeId",
      params: { topicId: params.topicId, nodeId: params.nodeId },
      search: (prev: NodeSearch) => ({ ...prev, w: true as const }),
      replace: true,
    });
  }, [navigate, params.topicId, params.nodeId]);
}

/** Close Inspect (clears `?w=1`, replace — back won't re-open it). */
export function useCloseInspect() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as {
    topicId?: TopicId;
    nodeId?: NodeId;
  };
  return useCallback(() => {
    if (!params.topicId || !params.nodeId) return;
    void navigate({
      to: "/$topicId/$nodeId",
      params: { topicId: params.topicId, nodeId: params.nodeId },
      search: (_prev: NodeSearch) => ({}),
      replace: true,
    });
  }, [navigate, params.topicId, params.nodeId]);
}

/**
 * Browser-style history primitives.
 *
 * The cursor is tracked in `workspaceUI` (`navBack` / `navForward`)
 * because TanStack Router's `BrowserHistory` doesn't expose its index
 * and `window.history.length` counts entries from outside the SPA too.
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
