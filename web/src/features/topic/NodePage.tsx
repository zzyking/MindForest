/**
 * `/$topicId/$nodeId` route — the workspace's main view. Reads ids from
 * the URL and dispatches the right pane based on `viewMode`:
 *
 *   editor  → CodeMirror-based NodeEditor (keyed on topic/node so the
 *             pending save flushes via unmount when navigating)
 *   tree    → sigma canvas, single-topic deep dive
 *   forest  → sigma canvas, whole-workspace many-trees overview
 *
 * View mode lives in workspaceUI (per-tab UI state). The outer wrapper
 * is keyed on `viewMode` so React fully unmounts the previous pane and
 * mounts the next one — each pane keeps doing its own data fetch on
 * mount, and the new pane settles in via `view-pane-in`. TreeView
 * still runs its internal stagger inside that wrapper; the outer keyframe
 * uses opacity + scale only (no translateY) so it can't push h-full
 * content past main's overflow-y-auto mid-animation.
 */

import { useParams } from "@tanstack/react-router";

import { ForestView } from "@/features/forest/ForestView";
import { NodeEditor } from "@/features/editor/NodeEditor";
import { TreeView } from "@/features/tree/TreeView";
import { useWorkspaceUI } from "@/stores/workspaceUI";
import type { NodeId, TopicId } from "@/lib/types";

export function NodePage() {
  // Loose-typed because rootRoute mounts before route generics resolve;
  // the values are guaranteed by the route path so we narrow with `as`.
  const { topicId, nodeId } = useParams({ strict: false }) as {
    topicId: TopicId;
    nodeId: NodeId;
  };
  const viewMode = useWorkspaceUI((s) => s.viewMode);

  let pane: React.ReactNode;
  if (viewMode === "tree") {
    pane = <TreeView topicId={topicId} focusedNodeId={nodeId} />;
  } else if (viewMode === "forest") {
    pane = <ForestView focusedTopicId={topicId} focusedNodeId={nodeId} />;
  } else {
    pane = <NodeEditor key={`${topicId}/${nodeId}`} nodeId={nodeId} />;
  }

  return (
    <div
      key={viewMode}
      className="h-full animate-[view-pane-in_320ms_cubic-bezier(0.2,0.8,0.2,1)_both]"
    >
      {pane}
    </div>
  );
}
