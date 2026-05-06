/**
 * `/$topicId/$nodeId` route — the workspace's main view. Reads ids from
 * the URL and dispatches the right pane based on `viewMode`:
 *
 *   editor  → CodeMirror-based NodeEditor (keyed on topic/node so the
 *             pending save flushes via unmount when navigating)
 *   forest  → sigma canvas with the topic's tree backbone + cross-refs
 *
 * View mode lives in workspaceUI (per-tab UI state). We swap whole panes
 * rather than cross-fading because each pane prefetches/computes its own
 * data; cross-fade buys little visually and forces both to stay mounted.
 */

import { useParams } from "@tanstack/react-router";

import { ForestView } from "@/features/forest/ForestView";
import { NodeEditor } from "@/features/editor/NodeEditor";
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

  if (viewMode === "forest") {
    return <ForestView topicId={topicId} focusedNodeId={nodeId} />;
  }
  return <NodeEditor key={`${topicId}/${nodeId}`} nodeId={nodeId} />;
}
