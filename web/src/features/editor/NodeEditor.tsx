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
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { ArrowLeft, ArrowRight, BookOpen, CircleHelp, Plus, SquarePen, Trash2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { useFocusNode, useNav } from "@/app/navigation";
import { useForestData } from "@/stores/forestData";
import { ApiError } from "@/lib/api";
import { TypeChip } from "@/ui/TypeChip";
import type { NodeId, NodePatch, NodeType, TopicId } from "@/lib/types";

import { Breadcrumb } from "./Breadcrumb";
import { CodeMirrorView } from "./CodeMirrorView";
import { LinksPanel } from "./LinksPanel";
import { MetadataLine } from "./MetadataLine";
import { TitleInput } from "./TitleInput";
import { TypePicker } from "./TypePicker";
import { linkPicker } from "./linkPicker";
import { livePreviewExtensions } from "./livePreviewExtensions";
import { useDebouncedSave } from "./useDebouncedSave";

interface Props {
  nodeId: NodeId;
  topicId: TopicId;
}

/**
 * Editor view modes:
 *   write — CodeMirror with live-preview decorations (Obsidian-style)
 *   read  — react-markdown rendered output
 */
type Mode = "write" | "read";

export function NodeEditor({ nodeId, topicId }: Props) {
  const node = useForestData((s) => s.nodes[nodeId]);
  const loading = useForestData((s) => s.loading.node[nodeId] ?? false);
  const fetchError = useForestData((s) => s.errors.node[nodeId] ?? null);
  const fetchNode = useForestData((s) => s.fetchNode);
  const patchNode = useForestData((s) => s.patchNode);
  const createNode = useForestData((s) => s.createNode);
  const deleteNode = useForestData((s) => s.deleteNode);
  const topicDetails = useForestData((s) => s.topicDetails);

  const focusNode = useFocusNode();
  const { back, forward, canGoBack, canGoForward } = useNav();

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

  // Type changes are discrete picks, not keystrokes — fire the PATCH
  // immediately instead of routing through the debounced queue. The
  // store's patchNode is optimistic and rolls back on failure.
  const onTypeChange = useCallback(
    (t: NodeType) => {
      if (!node || t === node.type) return;
      void patchNode(node.id, { type: t }).catch((e) => {
        if (e instanceof ApiError) setError(`save failed: ${e.message}`);
        else setError(`save failed: ${String(e)}`);
      });
    },
    [node, patchNode],
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
      await focusNode(child.id, child.topic);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [node, flush, createNode, focusNode]);

  // Two-click confirm: first click arms the button (label flips to
  // "Click again to confirm"), second click within 3s actually deletes.
  // Works around Tauri 2 disabling `window.confirm` and avoids piling on
  // a modal dialog component for a single confirmation.
  const [deleteArmed, setDeleteArmed] = useState(false);
  const armResetRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (armResetRef.current != null) window.clearTimeout(armResetRef.current);
    },
    [],
  );
  const onDelete = useCallback(async () => {
    if (!node || isRoot) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      if (armResetRef.current != null) window.clearTimeout(armResetRef.current);
      armResetRef.current = window.setTimeout(() => setDeleteArmed(false), 3000);
      return;
    }
    setDeleteArmed(false);
    if (armResetRef.current != null) {
      window.clearTimeout(armResetRef.current);
      armResetRef.current = null;
    }
    await flush();
    const parentId = node.parent;
    try {
      await deleteNode(node.id);
      // Move focus to parent. `replace: true` swaps the URL without
      // pushing a history entry, so back-button doesn't return to a
      // freshly-deleted node.
      if (parentId) {
        await focusNode(parentId, node.topic, { replace: true });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [node, isRoot, deleteArmed, flush, deleteNode, focusNode]);

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

  if (!node) {
    if (fetchError && !loading) {
      return (
        <EditorScaffold>
          <EmptyState>Couldn’t load this page — {fetchError}</EmptyState>
        </EditorScaffold>
      );
    }
    // Pending fetch. Paint the chrome immediately from the sidebar's
    // NodeSummary (toolbar, breadcrumb, title) so navigation reads as
    // "the body fills in" instead of a full-pane loading flash — the
    // editor's web-rendered remount becomes invisible. Deep links that
    // arrive before the topic detail fall back to an empty title for
    // the few frames the fetch needs.
    const summary = topicDetails[topicId]?.nodes.find((n) => n.id === nodeId);
    return (
      <EditorScaffold>
        <Toolbar
          mode={mode}
          onModeChange={setMode}
          canBack={canGoBack}
          canForward={canGoForward}
          onBack={onBack}
          onForward={onForward}
          onAddChild={onAddChild}
          onDelete={onDelete}
          canDelete={false}
          deleteArmed={false}
        />
        <Breadcrumb nodeId={nodeId} topicId={topicId} />
        <TitleInput
          value={summary?.title ?? ""}
          onChange={() => {}}
          disabled
          placeholder="Untitled"
          ariaLabel="Node title"
        />
        {/* Same-height placeholders for the metadata row and editor
            body so the real content swaps in without layout shift.
            min-h matches the live row's TypePicker chip height (18px);
            render a static chip from the summary when we have one so
            the type doesn't pop in after the fetch. */}
        <div aria-hidden className="flex min-h-[18px] items-center">
          {summary ? <TypeChip type={summary.type} /> : <span>&nbsp;</span>}
        </div>
        <div aria-hidden className="min-h-[24vh]" />
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
        canBack={canGoBack}
        canForward={canGoForward}
        onBack={onBack}
        onForward={onForward}
        onAddChild={onAddChild}
        onDelete={onDelete}
        canDelete={!isRoot}
        deleteArmed={deleteArmed}
      />
      <Breadcrumb nodeId={node.id} topicId={node.topic} />
      <TitleInput
        value={node.title}
        onChange={onTitleChange}
        placeholder="Untitled"
        ariaLabel="Node title"
      />
      {/* Metadata row: editable type chip + read-only timestamps. The
          min-h pins the row to the chip's 18px so the loading skeleton
          (above) can reserve the exact same height. */}
      <div className="flex min-h-[18px] flex-wrap items-center gap-3">
        <TypePicker value={node.type} onChange={onTypeChange} />
        <MetadataLine node={node} />
      </div>
      {mode === "write" ? (
        <CodeMirrorView
          value={node.content}
          onChange={onContentChange}
          extensions={[
            ...(editorExtensionsRef.current ? [editorExtensionsRef.current] : []),
            ...livePreviewExtensions,
          ]}
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
    <article className="@container mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
      {children}
    </article>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  // Soft, italic, paper-tone helper. Beats raw "Loading…" / "(empty)"
  // labels at carrying the brand voice while telling the user the same
  // thing.
  return (
    <p className="text-forest-400 mt-12 text-center font-serif text-base italic">
      {children}
    </p>
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
  deleteArmed: boolean;
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
  deleteArmed,
}: ToolbarProps) {
  const btn =
    "inline-flex items-center gap-1.5 h-7 px-2 text-sm transition-colors rounded whitespace-nowrap";
  const navBtn = cn(btn, "text-forest-600 hover:text-forest-900 disabled:text-forest-300 disabled:cursor-not-allowed");

  return (
    <div className="text-forest-600 flex items-center justify-between text-sm">
      <div className="flex items-center">
        <button type="button" className={navBtn} onClick={onBack} disabled={!canBack} aria-label="Back">
          <ArrowLeft size={14} strokeWidth={2} aria-hidden />
          <span className="hidden @[480px]:inline">Back</span>
        </button>
        <button type="button" className={navBtn} onClick={onForward} disabled={!canForward} aria-label="Forward">
          <span className="hidden @[480px]:inline">Forward</span>
          <ArrowRight size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>
      <div className="flex items-center gap-0.5">
        <ModeToggle value={mode} onChange={onModeChange} />
        <span aria-hidden className="bg-forest-200/60 mx-1 h-4 w-px" />
        <button type="button" className={cn(btn, "text-forest-600 hover:text-forest-900")} onClick={onAddChild} aria-label="Add child node">
          <Plus size={14} strokeWidth={2} aria-hidden />
          <span className="hidden @[480px]:inline">Add child</span>
        </button>
        <button
          type="button"
          className={cn(
            btn,
            canDelete
              ? deleteArmed
                ? "text-rust-700"
                : "text-accent hover:text-rust-700"
              : "text-forest-200 cursor-not-allowed",
          )}
          onClick={onDelete}
          disabled={!canDelete}
          aria-label={canDelete ? "Delete this node" : "Topic root cannot be deleted"}
          title={canDelete ? "Delete this node" : "Topic root cannot be deleted"}
        >
          {/* Narrow: icon only */}
          {deleteArmed
            ? <CircleHelp size={14} strokeWidth={2} aria-hidden className="@[480px]:hidden" />
            : <Trash2    size={14} strokeWidth={2} aria-hidden className="@[480px]:hidden" />}
          {/* Wide: icon+text in a fixed-width grid — spacer always holds
              the not-armed [Trash2 + "Delete"] dimensions so armed
              "Confirm?" text lands in the same footprint. */}
          <span className="hidden @[480px]:inline-grid">
            <span className="col-start-1 row-start-1 invisible inline-flex items-center gap-1.5" aria-hidden>
              <Trash2 size={14} strokeWidth={2} />Delete
            </span>
            <span className="col-start-1 row-start-1 inline-flex items-center gap-1.5 justify-center">
              {deleteArmed
                ? "Confirm?"
                : <><Trash2 size={14} strokeWidth={2} aria-hidden />Delete</>}
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}

const MODE_ITEMS = [
  { id: "write" as const, label: "Write", Icon: SquarePen },
  { id: "read"  as const, label: "Read",  Icon: BookOpen  },
];

function ModeToggle({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  return (
    <div role="tablist" aria-label="Editor mode" className="inline-flex items-center">
      {MODE_ITEMS.map(({ id, label, Icon }) => {
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={label}
            onClick={() => onChange(id)}
            className={cn(
              "relative h-7 px-2 text-sm inline-flex items-center gap-1.5 transition-colors rounded",
              "after:absolute after:left-2 after:right-2 after:bottom-0.5 after:h-[2px] after:rounded-full after:transition-colors",
              active
                ? "text-forest-900 font-medium after:bg-accent"
                : "text-forest-500 hover:text-forest-800 after:bg-transparent",
            )}
          >
            <Icon size={14} strokeWidth={2} aria-hidden />
            <span className="hidden @[480px]:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ReadView({ content }: { content: string }) {
  // remark-breaks turns single newlines into <br>, mirroring Obsidian /
  // Typora — they treat each line as its own line rather than the
  // CommonMark default of "fold soft-breaks into spaces". Pairs with
  // remark-gfm for tables / task-lists / strikethrough.
  if (content.trim().length === 0) {
    return (
      <p className="text-forest-400 mt-2 font-serif text-base italic">
        Nothing here yet. Switch to Write mode to start drafting.
      </p>
    );
  }
  return (
    <div className="prose prose-stone max-w-none text-base leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{content}</ReactMarkdown>
    </div>
  );
}
