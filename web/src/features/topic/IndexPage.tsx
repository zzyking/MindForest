/**
 * Landing route. If a topic exists, redirect to it; otherwise show a
 * single-shot create flow. The redirect goes to `/$topicId` (the topic
 * route), which then redirects to its root node — chaining keeps the
 * URL bar honest about where you are.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { ApiError } from "@/lib/api";
import { useForestData } from "@/stores/forestData";

export function IndexPage() {
  const navigate = useNavigate();
  const fetchTopics = useForestData((s) => s.fetchTopics);
  const createTopic = useForestData((s) => s.createTopic);
  const topics = useForestData((s) => s.topics);
  const topicsLoading = useForestData((s) => s.loading.topics);
  const topicsError = useForestData((s) => s.errors.topics);
  const [bootError, setBootError] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void fetchTopics().catch((e) => {
      setBootError(e instanceof Error ? e.message : String(e));
    });
  }, [fetchTopics]);

  // Once topics are known, hop to the first one. Sorted by slug for
  // determinism so refreshes don't flicker between topics.
  useEffect(() => {
    const list = Object.values(topics).sort((a, b) => a.id.localeCompare(b.id));
    const first = list[0];
    if (first) {
      void navigate({ to: "/$topicId", params: { topicId: first.id }, replace: true });
    }
  }, [topics, navigate]);

  const onCreate = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const title = draftTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    try {
      const topic = await createTopic(title);
      void navigate({
        to: "/$topicId/$nodeId",
        params: { topicId: topic.id, nodeId: topic.root_node_id },
        replace: true,
      });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setBootError(msg);
    } finally {
      setCreating(false);
    }
  };

  if (bootError) {
    return (
      <Frame>
        <p className="text-rust-700 font-medium">Could not reach the API.</p>
        <p className="text-forest-700 max-w-prose text-sm">{bootError}</p>
        <p className="text-forest-600 text-xs">
          Start it from the repo root:{" "}
          <code className="bg-forest-100 text-forest-800 rounded px-1 py-0.5 font-mono">
            npm run api
          </code>
        </p>
      </Frame>
    );
  }

  if (topicsLoading && Object.keys(topics).length === 0) {
    return (
      <Frame>
        <p className="text-forest-400">Loading workspace…</p>
      </Frame>
    );
  }

  if (Object.keys(topics).length === 0) {
    return (
      <Frame>
        <h1 className="font-serif text-4xl text-forest-800">MindForest</h1>
        <p className="text-forest-500 max-w-prose">
          No topics yet. Create one to start a forest.
        </p>
        <form onSubmit={onCreate} className="flex w-full max-w-sm items-center gap-2">
          <input
            autoFocus
            type="text"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder="Topic title"
            disabled={creating}
            className="border-forest-200 bg-forest-50 placeholder:text-forest-400 focus:border-forest-500 flex-1 rounded-full border px-4 py-2 text-sm focus:outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!draftTitle.trim() || creating}
            className="bg-forest-800 text-sand-100 hover:bg-forest-700 disabled:opacity-50 rounded-full px-4 py-2 text-sm"
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </form>
        {topicsError && (
          <p className="text-accent text-sm">Topics fetch error: {topicsError}</p>
        )}
      </Frame>
    );
  }

  // Topics exist; redirect effect above will fire — show a brief shim.
  return (
    <Frame>
      <p className="text-forest-400">Opening last topic…</p>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 py-16">
      <div className="flex max-w-prose flex-col items-center gap-3 text-center">{children}</div>
    </div>
  );
}
