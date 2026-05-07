/**
 * TreeView — subtree card explorer.
 *
 * Anchored on the currently focused node; renders three regions
 * stacked vertically:
 *
 *   - Ancestor trail: the chain from the topic root down to the focused
 *     node's parent. Small breadcrumb-style cards, each clickable.
 *   - Focus card: the focused node rendered large — type chip, title in
 *     Crimson Pro, metadata strip, and a content preview (first ~600
 *     chars of the markdown body).
 *   - Children grid: every direct child as a medium card (type chip +
 *     title + child-count badge). Clicking dives one level deeper.
 *   - Cross-references: any nodes linked from the focused one, rendered
 *     as a compact list. Same-topic links navigate within the topic;
 *     cross-topic links carry a topic badge.
 *
 * No canvas, no sigma — pure React. The visual model is closer to Roam
 * Backlinks / Logseq's page view than to a graph viz, which makes
 * sense once the sidebar already shows the literal tree.
 */

import { useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/cn";
import { useFocusNode } from "@/app/navigation";
import { useForestData } from "@/stores/forestData";
import type { NodeId, NodeSummary, NodeType, TopicId } from "@/lib/types";

interface Props {
  topicId: TopicId;
  focusedNodeId: NodeId;
}

const TYPE_LABEL: Record<NodeType, string> = {
  concept: "concept",
  fact: "fact",
  source: "source",
  example: "example",
  question: "question",
  task: "task",
  misc: "misc",
};

const TYPE_TONE: Record<NodeType, string> = {
  concept: "bg-forest-100 text-forest-700",
  fact: "bg-sand-200 text-forest-700",
  source: "bg-rust-100 text-rust-700",
  example: "bg-rust-50 text-rust-700",
  question: "bg-forest-100 text-forest-600",
  task: "bg-forest-100 text-forest-700",
  misc: "bg-sand-200 text-forest-500",
};

const PREVIEW_CHARS = 600;

export function TreeView({ topicId, focusedNodeId }: Props) {
  const detail = useForestData((s) => s.topicDetails[topicId]);
  const fetchTopic = useForestData((s) => s.fetchTopic);
  // We need the focused node's full content for the anchor card; the
  // topic-detail summaries only carry titles + parents + links. Fall
  // back to the cache; otherwise fetch on demand.
  const focusedFull = useForestData((s) => s.nodes[focusedNodeId]);
  const fetchNode = useForestData((s) => s.fetchNode);

  const focus = useFocusNode();

  useEffect(() => {
    if (!detail) void fetchTopic(topicId).catch(() => {});
  }, [topicId, detail, fetchTopic]);

  useEffect(() => {
    if (!focusedFull) void fetchNode(focusedNodeId).catch(() => {});
  }, [focusedNodeId, focusedFull, fetchNode]);

  if (!detail) {
    return <Scaffold>{<Hint>Loading the topic…</Hint>}</Scaffold>;
  }
  const focusedSummary = detail.nodes.find((n) => n.id === focusedNodeId);
  if (!focusedSummary) {
    return <Scaffold>{<Hint>Node not found in this topic.</Hint>}</Scaffold>;
  }

  const summaryById = new Map(detail.nodes.map((n) => [n.id, n] as const));
  const ancestors = computeAncestors(focusedSummary, summaryById);
  const children = detail.nodes
    .filter((n) => n.parent === focusedNodeId)
    .sort((a, b) => a.id.localeCompare(b.id));
  const childCountByParent = new Map<NodeId, number>();
  for (const n of detail.nodes) {
    if (!n.parent) continue;
    childCountByParent.set(n.parent, (childCountByParent.get(n.parent) ?? 0) + 1);
  }
  const linkSummaries = focusedSummary.links
    .map((id) => summaryById.get(id))
    .filter((n): n is NodeSummary => Boolean(n));

  return (
    <Scaffold>
      {ancestors.length > 0 && <AncestorTrail trail={ancestors} topicId={topicId} onPick={focus} />}
      <FocusCard
        summary={focusedSummary}
        content={focusedFull?.content ?? null}
        contentLoading={!focusedFull}
      />
      {children.length > 0 && (
        <ChildGrid
          topicId={topicId}
          children={children}
          childCountByParent={childCountByParent}
          onPick={focus}
        />
      )}
      {linkSummaries.length > 0 && (
        <LinkList topicId={topicId} links={linkSummaries} onPick={focus} />
      )}
    </Scaffold>
  );
}

function Scaffold({ children }: { children: React.ReactNode }) {
  return (
    <article className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6">
      {children}
    </article>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-forest-400 mt-12 text-center font-serif text-base italic">{children}</p>
  );
}

function computeAncestors(
  node: NodeSummary,
  byId: Map<NodeId, NodeSummary>,
): NodeSummary[] {
  const out: NodeSummary[] = [];
  const seen = new Set<NodeId>();
  let cursor: NodeId | null = node.parent;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const p = byId.get(cursor);
    if (!p) break;
    out.unshift(p);
    cursor = p.parent;
  }
  return out;
}

interface AncestorTrailProps {
  trail: NodeSummary[];
  topicId: TopicId;
  onPick: (id: NodeId, topicId: TopicId) => void | Promise<void>;
}

function AncestorTrail({ trail, topicId, onPick }: AncestorTrailProps) {
  return (
    <nav aria-label="Ancestors" className="flex flex-wrap items-center gap-2">
      {trail.map((n, i) => (
        <span key={n.id} className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void onPick(n.id, topicId)}
            className={cn(
              "border-forest-200 bg-sand-100 hover:border-forest-400 hover:bg-sand-200/60",
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
            )}
            title={n.title || "Untitled"}
          >
            <TypeChip type={n.type} compact />
            <span className="text-forest-700 max-w-[18ch] truncate">
              {n.title || "Untitled"}
            </span>
          </button>
          {i < trail.length - 1 && (
            <span aria-hidden className="text-forest-300 text-xs">
              ›
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

interface FocusCardProps {
  summary: NodeSummary;
  content: string | null;
  contentLoading: boolean;
}

function FocusCard({ summary, content, contentLoading }: FocusCardProps) {
  const preview = content ? truncatePreview(content, PREVIEW_CHARS) : null;
  return (
    <section
      className={cn(
        "border-forest-200 bg-sand-100/80 shadow-glass relative rounded-2xl border p-6 backdrop-blur-md",
      )}
    >
      <div className="mb-3 flex items-center gap-2">
        <TypeChip type={summary.type} />
        <span className="text-forest-400 text-[10px] uppercase tracking-[0.08em] tabular-nums">
          updated {formatRelative(new Date(summary.updated_at))}
        </span>
      </div>
      <h1 className="text-forest-900 mb-3 font-serif text-3xl font-semibold leading-tight tracking-tight">
        {summary.title || "Untitled"}
      </h1>
      {preview ? (
        <div className="prose prose-stone max-w-none text-base leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{preview}</ReactMarkdown>
        </div>
      ) : (
        <p className="text-forest-400 font-serif text-base italic">
          {contentLoading ? "Loading content…" : "Nothing in the body yet."}
        </p>
      )}
    </section>
  );
}

interface ChildGridProps {
  topicId: TopicId;
  children: NodeSummary[];
  childCountByParent: Map<NodeId, number>;
  onPick: (id: NodeId, topicId: TopicId) => void | Promise<void>;
}

function ChildGrid({ topicId, children, childCountByParent, onPick }: ChildGridProps) {
  return (
    <section>
      <SectionHeader>Children · {children.length}</SectionHeader>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {children.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => void onPick(c.id, topicId)}
            className={cn(
              "border-forest-200 bg-sand-100 hover:border-forest-400 hover:bg-sand-200/40",
              "group relative flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <TypeChip type={c.type} />
              {(childCountByParent.get(c.id) ?? 0) > 0 && (
                <span className="text-forest-400 text-[10px] uppercase tracking-[0.08em] tabular-nums">
                  {childCountByParent.get(c.id)} sub
                </span>
              )}
            </div>
            <h3 className="text-forest-800 group-hover:text-forest-900 line-clamp-2 font-serif text-lg leading-tight">
              {c.title || "Untitled"}
            </h3>
          </button>
        ))}
      </div>
    </section>
  );
}

interface LinkListProps {
  topicId: TopicId;
  links: NodeSummary[];
  onPick: (id: NodeId, topicId: TopicId) => void | Promise<void>;
}

function LinkList({ topicId, links, onPick }: LinkListProps) {
  return (
    <section>
      <SectionHeader>Linked · {links.length}</SectionHeader>
      <ul className="flex flex-wrap gap-2">
        {links.map((l) => (
          <li key={l.id}>
            <button
              type="button"
              onClick={() => void onPick(l.id, topicId)}
              className={cn(
                "border-forest-200 bg-sand-100 hover:border-accent hover:bg-rust-50/60",
                "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors",
              )}
              title={l.title || "Untitled"}
            >
              <TypeChip type={l.type} compact />
              <span className="text-forest-700 max-w-[24ch] truncate">
                {l.title || "Untitled"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-forest-500 mb-3 text-[10px] font-medium uppercase tracking-[0.12em]">
      {children}
    </h2>
  );
}

function TypeChip({ type, compact }: { type: NodeType; compact?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full font-medium uppercase tracking-[0.08em]",
        compact ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-0.5 text-[10px]",
        TYPE_TONE[type],
      )}
    >
      {TYPE_LABEL[type]}
    </span>
  );
}

function truncatePreview(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  // Cut at the next paragraph break or sentence boundary after maxChars
  // so we don't slice mid-word.
  const slice = content.slice(0, maxChars);
  const lastBreak = Math.max(
    slice.lastIndexOf("\n\n"),
    slice.lastIndexOf(". "),
    slice.lastIndexOf("。"),
  );
  if (lastBreak > maxChars * 0.6) {
    return slice.slice(0, lastBreak + 1).trimEnd() + "\n\n…";
  }
  return slice.trimEnd() + "…";
}

function formatRelative(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 30) return `${diffD}d ago`;
  return d.toISOString().slice(0, 10);
}
