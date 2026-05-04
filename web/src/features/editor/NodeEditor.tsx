/**
 * NodeEditor — main editor pane.
 *
 * Composition order top-to-bottom:
 *   Toolbar (back/forward · view toggle · add child · delete)
 *   Breadcrumb
 *   Title (autosize)
 *   MetadataLine
 *   Editor body (CodeMirror in write, react-markdown in read)
 *   LinksPanel
 *
 * State machine:
 * - The store (`useForestData.nodes`) is the source of truth for content.
 * - Local title/content drafts are unidirectional buffers — they only
 *   exist to debounce writes. Every keystroke updates both the local
 *   draft and the store optimistically (`patchNode`); the debounced
 *   `queue()` schedules the network PATCH. Read paths everywhere else
 *   in the app see the optimistic value.
 * - Navigation (`focusNode`) flushes any pending save first so we never
 *   write A's content into B's file.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/cn";
import { useForestData } from "@/stores/forestData";
import { useWorkspaceUI } from "@/stores/workspaceUI";
import { ApiError } from "@/lib/api";
import type { NodeId, NodePatch } from "@/lib/types";

import { Breadcrumb } from "./Breadcrumb";
import { CodeMirrorView } from "./CodeMirrorView";
import { LinksPanel } from "./LinksPanel";
import { MetadataLine } from "./MetadataLine";
import { TitleInput } from "./TitleInput";
import { linkPicker } from "./linkPicker";
import { useDebouncedSave } from "./useDebouncedSave";

interface Props {
  nodeId: NodeId;
}

type Mode = "write" | "read";

export function NodeEditor({ nodeId }: Props) {
  const node = useForestData((s) => s.nodes[nodeId]);
  const loading = useForestData((s) => s.loading.node[nodeId] ?? false);
  const fetchNode = useForestData((s) => s.fetchNode);
  const patchNode = useForestData((s) => s.patchNode);
  const createNode = useForestData((s) => s.createNode);
  const deleteNode = useForestData((s) => s.deleteNode);
  const topicDetails = useForestData((s) => s.topicDetails);

  const focusedNodeId = useWorkspaceUI((s) => s.focusedNodeId);
  const setFocusReplacing = useWorkspaceUI((s) => s.setFocusReplacing);
  const back = useWorkspaceUI((s) => s.back);
  const forward = useWorkspaceUI((s) => s.forward);
  const canBack = useWorkspaceUI((s) => s.canGoBack());
  const canFwd = useWorkspaceUI((s) => s.canGoForward());
  const focusNode = useWorkspaceUI((s) => s.focusNode);

  const [mode, setMode] = useState<Mode>("write");
  const [error, setError] = useState<string | null>(null);

  // Fetch on mount / id change. The store guards against duplicate
  // in-flight fetches via the loading map.
  useEffect(() => {
    if (!node && !loading) {
      void fetchNode(nodeId).catch(() => {});
    }
  }, [nodeId, node, loading, fetchNode]);

  // Debounced save: any change to `title`, `content`, or `links` is
  // queued under the *node id at queue time*, never the currently
  // focused id, so cross-node writes are impossible.
  const { queue, flush } = useDebouncedSave<NodePatch>(
    async (targetId, patch) => {
      await patchNode(targetId, patch);
    },
    {
      onError: (e) => {
        if (e instanceof ApiError) setError(`save failed: ${e.message}`);
        else setError(`save failed: ${String(e)}`);
      },
    },
  );

  // Flush whenever focused node id moves away from us (the parent
  // re-mounts NodeEditor with a new key by convention). We additionally
  // flush before navigation actions below.
  useEffect(() => {
    return () => {
      void flush();
    };
  }, [flush]);

  const isRoot = useMemo(() => {
    if (!node) return false;
    const detail = topicDetails[node.topic];
    return detail?.root_node_id === node.id;
  }, [node, topicDetails]);

  const onTitleChange = useCallback(
    (next: string) => {
      if (!node) return;
      void queue(node.id, { title: next });
      // Optimistic local mirror via patchNode without re-firing the
      // network: cheap shortcut — drop a draft straight into the store.
      // The debounced save will reconcile.
      const draft = { ...node, title: next };
      useForestData.setState((s) => ({ nodes: { ...s.nodes, [node.id]: draft } }));
    },
    [node, queue],
  );

  const onContentChange = useCallback(
    (next: string) => {
      if (!node) return;
      void queue(node.id, { content: next });
      const draft = { ...node, content: next };
      useForestData.setState((s) => ({ nodes: { ...s.nodes, [node.id]: draft } }));
    },
    [node, queue],
  );

  const onAddChild = useCallback(async () => {
    if (!node) return;
    await flush();
    try {
      const child = await createNode({
        topic: node.topic,
        parent: node.id,
        title: "Untitled",
        content: "",
        node_type: "concept",
      });
      focusNode(child.id, child.topic);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [node, flush, createNode, focusNode]);

  const onDelete = useCallback(async () => {
    if (!node || isRoot) return;
    if (!window.confirm(`Delete "${node.title}"?`)) return;
    await flush();
    const parentId = node.parent;
    try {
      await deleteNode(node.id);
      // Move focus to parent without pushing the deleted id onto the
      // history stack — `setFocusReplacing` skips the back-stack write.
      setFocusReplacing(parentId, node.topic);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [node, isRoot, flush, deleteNode, setFocusReplacing]);

  const onBack = useCallback(async () => {
    await flush();
    back();
  }, [back, flush]);
  const onForward = useCallback(async () => {
    await flush();
    forward();
  }, [forward, flush]);

  // Stable extension list per editor mount (the linkPicker closes over
  // currentTopic + own-id for self-link suppression).
  const editorExtensionsRef = useRef<ReturnType<typeof linkPicker> | null>(null);
  if (!editorExtensionsRef.current && node) {
    editorExtensionsRef.current = linkPicker({
      currentTopic: node.topic,
      excludeIds: [node.id],
    });
  }

  if (loading && !node) {
    return <EditorScaffold>{<p className="text-forest-400">Loading…</p>}</EditorScaffold>;
  }
  if (!node) {
    return (
      <EditorScaffold>
        <p className="text-forest-400">No node selected.</p>
      </EditorScaffold>
    );
  }

  // Even though `nodeId` is the prop, the store value drives display so
  // optimistic updates show without re-renders waiting on PATCH.
  return (
    <EditorScaffold>
      <Toolbar
        mode={mode}
        onModeChange={setMode}
        canBack={canBack}
        canForward={canFwd}
        onBack={onBack}
        onForward={onForward}
        onAddChild={onAddChild}
        onDelete={onDelete}
        canDelete={!isRoot}
        focusedHere={focusedNodeId === node.id}
      />
      <Breadcrumb nodeId={node.id} topicId={node.topic} />
      <TitleInput
        value={node.title}
        onChange={onTitleChange}
        placeholder="Untitled"
        ariaLabel="Node title"
      />
      <MetadataLine node={node} />
      {mode === "write" ? (
        <CodeMirrorView
          value={node.content}
          onChange={onContentChange}
          extensions={editorExtensionsRef.current ? [editorExtensionsRef.current] : []}
          ariaLabel="Node body"
          className="min-h-[24vh]"
        />
      ) : (
        <ReadView content={node.content} />
      )}
      <LinksPanel node={node} />
      {error && (
        <div className="text-accent border-accent bg-sand-100 rounded border px-3 py-2 text-sm">
          {error}
        </div>
      )}
    </EditorScaffold>
  );
}

function EditorScaffold({ children }: { children: React.ReactNode }) {
  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
      {children}
    </article>
  );
}

interface ToolbarProps {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onAddChild: () => void;
  onDelete: () => void;
  canDelete: boolean;
  focusedHere: boolean;
}

function Toolbar({
  mode,
  onModeChange,
  canBack,
  canForward,
  onBack,
  onForward,
  onAddChild,
  onDelete,
  canDelete,
  focusedHere,
}: ToolbarProps) {
  const navBtn = "text-forest-500 hover:text-forest-800 disabled:text-forest-200 px-2 py-1 text-sm";
  return (
    <div className="text-forest-600 flex items-center justify-between text-sm">
      <div className="flex items-center gap-1">
        <button type="button" className={navBtn} onClick={onBack} disabled={!canBack} aria-label="Back">
          ← Back
        </button>
        <button
          type="button"
          className={navBtn}
          onClick={onForward}
          disabled={!canForward}
          aria-label="Forward"
        >
          Forward →
        </button>
      </div>
      <div className="flex items-center gap-2">
        {!focusedHere && <span className="text-forest-300 text-xs">(out of focus)</span>}
        <ModeToggle value={mode} onChange={onModeChange} />
        <button
          type="button"
          className={cn(navBtn, "text-forest-500 hover:text-forest-800")}
          onClick={onAddChild}
        >
          + Add child
        </button>
        <button
          type="button"
          className={cn(
            "px-2 py-1 text-sm",
            canDelete ? "text-accent hover:underline" : "text-forest-200",
          )}
          onClick={onDelete}
          disabled={!canDelete}
          title={canDelete ? "Delete this node" : "Topic root cannot be deleted"}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function ModeToggle({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="border-forest-200 inline-flex overflow-hidden rounded-full border">
      {(["write", "read"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={cn(
            "px-3 py-1 text-xs",
            value === m
              ? "bg-forest-800 text-sand-100"
              : "text-forest-500 hover:text-forest-700 bg-transparent",
          )}
        >
          {m === "write" ? "Write" : "Read"}
        </button>
      ))}
    </div>
  );
}

function ReadView({ content }: { content: string }) {
  return (
    <div className="prose prose-forest max-w-none text-base leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || "*(empty)*"}</ReactMarkdown>
    </div>
  );
}
