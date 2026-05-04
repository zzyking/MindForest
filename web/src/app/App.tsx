/**
 * Workspace shell. P1 scope is intentionally small:
 * - Boot: fetch topics; if zero, show a single-shot create flow.
 * - Once a topic is loaded, focus its root node and hand the editor a
 *   `nodeId` prop. NodeEditor owns its own data lifecycle from there.
 *
 * Tree / graph / unified views land in a later phase. Topic switcher
 * lives inline here for now to keep the surface flat — the dock + right
 * sidebar belong to #5/#9.
 */

import { useCallback, useEffect, useState } from "react";

import { ApiError } from "@/lib/api";
import { useForestData } from "@/stores/forestData";
import { useWorkspaceUI } from "@/stores/workspaceUI";
import { NodeEditor } from "@/features/editor/NodeEditor";
import "@/styles/globals.css";

export function App() {
  const topics = useForestData((s) => s.topics);
  const topicsLoading = useForestData((s) => s.loading.topics);
  const topicsError = useForestData((s) => s.errors.topics);
  const fetchTopics = useForestData((s) => s.fetchTopics);
  const fetchTopic = useForestData((s) => s.fetchTopic);
  const createTopic = useForestData((s) => s.createTopic);

  const focusedNodeId = useWorkspaceUI((s) => s.focusedNodeId);
  const currentTopicId = useWorkspaceUI((s) => s.currentTopicId);
  const setFocusReplacing = useWorkspaceUI((s) => s.setFocusReplacing);

  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    void fetchTopics().catch((e) => {
      setBootError(e instanceof Error ? e.message : String(e));
    });
  }, [fetchTopics]);

  // Pick a topic to focus on once topics load. Last-viewed (currentTopicId)
  // wins; otherwise first topic alphabetically (stable across refreshes).
  const topicList = Object.values(topics).sort((a, b) => a.id.localeCompare(b.id));
  useEffect(() => {
    if (focusedNodeId) return;
    if (topicList.length === 0) return;
    const target = currentTopicId ?? topicList[0]!.id;
    void fetchTopic(target)
      .then((detail) => setFocusReplacing(detail.root_node_id, detail.id))
      .catch((e) => setBootError(e instanceof Error ? e.message : String(e)));
    // topicList changes identity each render — depend only on length so
    // we don't loop on cache reconciliation. The id resolution above is
    // sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicList.length, focusedNodeId, currentTopicId, fetchTopic, setFocusReplacing]);

  const onCreateTopic = useCallback(async () => {
    const title = window.prompt("Topic title");
    if (!title?.trim()) return;
    try {
      const topic = await createTopic(title.trim());
      setFocusReplacing(topic.root_node_id, topic.id);
    } catch (e) {
      const msg =
        e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
      setBootError(msg);
    }
  }, [createTopic, setFocusReplacing]);

  if (bootError) {
    return (
      <Frame>
        <p className="text-accent">Could not reach the API.</p>
        <p className="text-forest-500 max-w-prose text-sm">{bootError}</p>
        <p className="text-forest-400 text-xs">
          Start it from the repo root: <code className="font-mono">npm run api</code>
        </p>
      </Frame>
    );
  }

  if (topicsLoading && topicList.length === 0) {
    return (
      <Frame>
        <p className="text-forest-400">Loading workspace…</p>
      </Frame>
    );
  }

  if (topicList.length === 0) {
    return (
      <Frame>
        <h1 className="font-serif text-4xl">MindForest</h1>
        <p className="text-forest-500 max-w-prose">
          No topics yet. Create one to start a forest.
        </p>
        <button
          type="button"
          onClick={onCreateTopic}
          className="bg-forest-800 text-sand-100 hover:bg-forest-700 rounded-full px-4 py-2 text-sm"
        >
          New topic
        </button>
        {topicsError && (
          <p className="text-accent text-sm">Topics fetch error: {topicsError}</p>
        )}
      </Frame>
    );
  }

  return (
    <main className="bg-noise relative flex min-h-screen flex-col bg-forest-50 text-forest-900">
      <header className="border-forest-100 bg-sand-100/80 sticky top-0 z-10 flex items-center justify-between border-b px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <h1 className="font-serif text-2xl tracking-tight">MindForest</h1>
          <TopicSwitcher
            topics={topicList}
            currentTopicId={currentTopicId ?? topicList[0]!.id}
            onSelect={(id) =>
              fetchTopic(id)
                .then((detail) => setFocusReplacing(detail.root_node_id, detail.id))
                .catch((e) => setBootError(e instanceof Error ? e.message : String(e)))
            }
            onNew={onCreateTopic}
          />
        </div>
      </header>
      <section className="flex-1 overflow-y-auto">
        {focusedNodeId ? (
          <NodeEditor key={focusedNodeId} nodeId={focusedNodeId} />
        ) : (
          <p className="text-forest-400 px-6 py-6">No node focused.</p>
        )}
      </section>
    </main>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="bg-noise relative flex min-h-screen items-center justify-center bg-forest-50 px-6 py-16 text-forest-900">
      <div className="flex max-w-prose flex-col items-center gap-3 text-center">{children}</div>
    </main>
  );
}

interface TopicSwitcherProps {
  topics: Array<{ id: string; title: string }>;
  currentTopicId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
}

function TopicSwitcher({ topics, currentTopicId, onSelect, onNew }: TopicSwitcherProps) {
  return (
    <div className="flex items-center gap-2">
      <select
        value={currentTopicId}
        onChange={(e) => onSelect(e.currentTarget.value)}
        className="border-forest-200 text-forest-700 bg-sand-100 rounded border px-2 py-1 text-sm"
        aria-label="Active topic"
      >
        {topics.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onNew}
        className="text-forest-500 hover:text-forest-800 text-sm underline-offset-4 hover:underline"
      >
        + topic
      </button>
    </div>
  );
}
