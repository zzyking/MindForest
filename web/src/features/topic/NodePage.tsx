/**
 * `/$topicId/$nodeId` route — the workspace's main view. Reads ids from
 * the URL and hands them to `NodeEditor` as a `key`-stabilized prop so
 * navigating between nodes remounts the editor cleanly (any pending
 * save in the previous node has already flushed via NodeEditor's
 * effect cleanup).
 */

import { useParams } from "@tanstack/react-router";

import { NodeEditor } from "@/features/editor/NodeEditor";

export function NodePage() {
  // Loose-typed because rootRoute mounts before route generics resolve;
  // the values are guaranteed by the route path so we narrow with `as`.
  const { topicId, nodeId } = useParams({ strict: false }) as {
    topicId: string;
    nodeId: string;
  };
  return <NodeEditor key={`${topicId}/${nodeId}`} nodeId={nodeId} />;
}
