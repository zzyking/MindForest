'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { X, Calendar, Hash, Trash2, Link2, Unlink, Plus, ArrowLeft, ArrowRight, BookOpen, SquarePen } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm'; // Adds support for tables, strikethrough, etc.
import TextareaAutosize from 'react-textarea-autosize';
import { format } from 'date-fns';
import { useForestDataStore } from '@/store/useForestDataStore';
import { useWorkspaceUIStore } from '@/store/useWorkspaceUIStore';
import { useDebounce } from '@/hooks/useDebounce';

export function NodeEditorPanel() {
  const focusedId = useWorkspaceUIStore((s) => s.focusedNodeId);
  const toggleSidebar = useWorkspaceUIStore((s) => s.toggleSidebar);
  const setFocus = useWorkspaceUIStore((s) => s.setFocus);
  const goToNode = useWorkspaceUIStore((s) => s.goToNode);
  const goBack = useWorkspaceUIStore((s) => s.goBack);
  const goForward = useWorkspaceUIStore((s) => s.goForward);
  const backStackLength = useWorkspaceUIStore((s) => s.backStack.length);
  const forwardStackLength = useWorkspaceUIStore((s) => s.forwardStack.length);
  const editorDraft = useWorkspaceUIStore((s) => s.editorDraft);
  const setEditorDraft = useWorkspaceUIStore((s) => s.setEditorDraft);
  const addNode = useForestDataStore((s) => s.addNode);
  const rootNodeId = useForestDataStore((s) => s.rootNodeId);
  const nodesMap = useForestDataStore((s) => s.nodes);
  const node = focusedId ? nodesMap[focusedId] : undefined;
  const updateNodeContent = useForestDataStore((s) => s.updateNodeContent);
  const updateNodeTitle = useForestDataStore((s) => s.updateNodeTitle);
  const deleteNode = useForestDataStore((s) => s.deleteNode);
  const linkNodes = useForestDataStore((s) => s.linkNodes);
  const unlinkNodes = useForestDataStore((s) => s.unlinkNodes);

  const draftNodeId = editorDraft.nodeId;
  const isDraftForFocusedNode = draftNodeId === focusedId;

  const localContent = isDraftForFocusedNode ? editorDraft.content : node?.content || '';
  const localTitle = isDraftForFocusedNode ? editorDraft.title : node?.title || '';
  const mode = editorDraft.mode;
  const linkTargetId = isDraftForFocusedNode ? editorDraft.linkTargetId : '';
  const updateDraft = (patch: Partial<typeof editorDraft>) => {
    if (!focusedId) return;
    setEditorDraft({ nodeId: focusedId, ...patch });
  };

  // Debounce saves to the global store (500ms delay)
  const debouncedContent = useDebounce(localContent, 500);
  const debouncedTitle = useDebounce(localTitle, 500);

  useEffect(() => {
    if (!node || draftNodeId !== node.id) return;

    // Only persist when the debounced values reflect the current node's local state,
    // otherwise switching focus would momentarily write the previous node's text here.
    const isContentSynced = debouncedContent === localContent;
    const isTitleSynced = debouncedTitle === localTitle;

    if (isContentSynced && debouncedContent !== node.content) {
      updateNodeContent(node.id, debouncedContent); 
    }
    if (isTitleSynced && debouncedTitle !== node.title) {
      updateNodeTitle(node.id, debouncedTitle);
    }
  }, [
    debouncedContent,
    debouncedTitle,
    localContent,
    localTitle,
    node,
    draftNodeId,
    updateNodeContent,
    updateNodeTitle
  ]);

  const handleDelete = () => {
    if (!node) return;
    if (node.id === rootNodeId) return;

    const fallbackFocus = node.parentId ?? rootNodeId;
    const nextFocus = deleteNode(node.id) ?? fallbackFocus;
    setFocus(nextFocus);
    toggleSidebar(false);
  };

  const handleAddChild = () => {
    if (!node) return;
    const createdId = addNode(node.id, 'New Node');
    if (createdId) {
      goToNode(createdId);
      toggleSidebar(true);
    }
  };

  const handleAddLink = (targetId: string) => {
    if (!node || !targetId) return;
    linkNodes(node.id, targetId);
    updateDraft({ linkTargetId: '' });
  };

  const handleNavigateToNode = (targetId: string) => {
    goToNode(targetId);
    toggleSidebar(true);
  };

  const linkedNodes = node ? (node.links || []).map((id) => nodesMap[id]).filter(Boolean) : [];
  const linkableNodes = node
    ? Object.values(nodesMap).filter(
        (n) => n.id !== node.id && !(node.links || []).includes(n.id)
      )
    : [];
  const filteredLinkableNodes = linkTargetId
    ? linkableNodes.filter((candidate) =>
        candidate.title.toLowerCase().includes(linkTargetId.toLowerCase())
      )
    : [];
  const breadcrumb = useMemo(() => {
    if (!node) return [];
    const seen = new Set<string>();
    const path: typeof linkedNodes = [];
    let current: typeof node | undefined = node;
    while (current && !seen.has(current.id)) {
      path.push(current);
      seen.add(current.id);
      current = current.parentId ? nodesMap[current.parentId] : undefined;
    }
    return path.reverse();
  }, [node, nodesMap]);

  if (!node) return null;

  return (
    <div className="flex flex-col h-full bg-sand-100 text-forest-900 border-l border-forest-100">
      
      {/* --- HEADER --- */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-forest-200 bg-sand-100 sticky top-0 z-10">
        <div className="text-xs font-bold text-forest-500 uppercase tracking-wider flex items-center gap-2 font-sans">
          <Hash size={12} />
          {node.type}
        </div>
        <div className="flex gap-2">
          <button
            onClick={goBack}
            disabled={backStackLength === 0}
            className={`p-2 rounded-full transition-colors ${
              backStackLength === 0
                ? 'text-forest-300 cursor-not-allowed'
                : 'text-forest-600 hover:bg-forest-200/50'
            }`}
            aria-label="Go back to previous node"
          >
            <ArrowLeft size={18} />
          </button>
          <button
            onClick={goForward}
            disabled={forwardStackLength === 0}
            className={`p-2 rounded-full transition-colors ${
              forwardStackLength === 0
                ? 'text-forest-300 cursor-not-allowed'
                : 'text-forest-600 hover:bg-forest-200/50'
            }`}
            aria-label="Go forward to next node"
          >
            <ArrowRight size={18} />
          </button>
          <button 
            onClick={() => toggleSidebar(false)}
            className="p-2 hover:bg-forest-200/50 rounded-full text-forest-500 transition-colors"
          >
            <X size={20} />
          </button>
        </div>
      </div>

      {/* --- SCROLLABLE CONTENT --- */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-8 py-2 max-w-3xl mx-auto">

          {/* Path + Mode Switch */}
          <div className="flex items-center justify-between mb-4 text-xs font-sans text-forest-500">
            <div className="flex items-center flex-wrap gap-1">
              {breadcrumb.map((crumb, index) => (
                <React.Fragment key={crumb.id}>
                  <button
                    onClick={() => handleNavigateToNode(crumb.id)}
                    className="text-forest-700 hover:text-forest-900 underline-offset-2 hover:underline"
                  >
                    {crumb.title || 'Untitled'}
                  </button>
                  {index < breadcrumb.length - 1 && <span>/</span>}
                </React.Fragment>
              ))}
            </div>
            <div className="flex items-center gap-1 text-forest-500">
              <button
                onClick={() => updateDraft({ mode: 'edit' })}
                className={`px-1 py-1 rounded-md transition-colors ${
                  mode === 'edit' ? 'text-forest-900 font-semibold' : 'hover:text-forest-800'
                }`}
              >
                <SquarePen size={12} className="inline-block" />
              </button>
              <span>/</span>
              <button
                onClick={() => updateDraft({ mode: 'preview' })}
                className={`px-1 py-1 rounded-md transition-colors ${
                  mode === 'preview' ? 'text-forest-900 font-semibold' : 'hover:text-forest-800'
                }`}
              >
                <BookOpen size={12} className="inline-block" />
              </button>
            </div>
          </div>

          {/* Title Input */}
          <TextareaAutosize
            value={localTitle}
            onChange={(e) => updateDraft({ title: e.target.value })}
            placeholder="Untitled Node"
            className="w-full text-4xl font-serif font-extrabold bg-transparent border-none focus:ring-0 resize-none placeholder:text-forest-300 text-forest-900 mb-4 leading-tight outline-none"
          />

          {/* Metadata Row */}
          <div className="flex gap-6 text-xs text-forest-500 mb-4 font-sans">
            <div className="flex items-center gap-1.5">
              <Calendar size={14} />
              {format(node.createdAt, 'MMM d, yyyy')}
            </div>
            <div className="flex items-center gap-1.5">
               ID: <span className="font-mono bg-forest-200/30 px-1 rounded text-forest-800">{node.id.slice(0,6)}</span>
            </div>
          </div>

          {/* Link List */}
          <div className="mb-4">
            <div className="px-0.5 text-xs uppercase tracking-wider text-forest-500 font-semibold mb-1">Connections</div>
            <div className="flex flex-wrap gap-2">
              {linkedNodes.map((linked) => (
                <span
                  key={linked.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleNavigateToNode(linked.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleNavigateToNode(linked.id);
                    }
                  }}
                  className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-forest-100 text-forest-800 border border-forest-200 text-xs cursor-pointer hover:bg-forest-50 transition-colors"
                >
                  {linked.title}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      unlinkNodes(node.id, linked.id);
                    }}
                    className="text-forest-500 hover:text-forest-800"
                    aria-label={`Unlink ${linked.title}`}
                  >
                    <Unlink size={12} />
                  </button>
                </span>
              ))}
            </div>

            <div className="mt-1 relative">
              <div className="flex px-0.5 items-center gap-2">
                <input
                  value={linkTargetId}
                  onChange={(e) => updateDraft({ linkTargetId: e.target.value })}
                  placeholder="Type to search nodes..."
                  className="flex-1 text-sm text-forest-800 focus:outline-none"
                />
              </div>
              {linkTargetId ? (
                <div className="absolute left-0 right-0 top-full mt-2 rounded-lg border border-forest-200 bg-white shadow-lg z-20 max-h-64 overflow-y-auto">
                  {filteredLinkableNodes.length > 0 ? (
                    <div className="flex flex-col divide-y divide-forest-100">
                      {filteredLinkableNodes.map((candidate) => (
                        <button
                          key={candidate.id}
                          onClick={() => handleAddLink(candidate.id)}
                          className="flex items-center justify-between px-3 py-2 text-left hover:bg-forest-50 transition-colors"
                        >
                          <span className="font-medium text-sm text-forest-900">{candidate.title}</span>
                          <span className="text-xs uppercase tracking-wide text-forest-400">
                            {candidate.id.slice(0, 6)}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="px-3 py-2 text-sm text-forest-400">
                      No matches yet. Keep typing to find a node.
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          {/* EDITOR AREA */}
          <div className="min-h-[400px]">
            {mode === 'edit' ? (
              <TextareaAutosize
                minRows={15}
                placeholder="Start typing your thoughts (Markdown supported)..."
                value={localContent}
                onChange={(e) => updateDraft({ content: e.target.value })}
                className="w-full h-full resize-none border-none focus:ring-0 text-lg leading-relaxed text-forest-800 placeholder:text-forest-300 bg-transparent font-serif outline-none"
              />
            ) : (
              <article className="prose prose-stone prose-lg max-w-none font-serif text-forest-800">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {localContent || '*No content yet...*'}
                </ReactMarkdown>
              </article>
            )}
          </div>

        </div>
      </div>

      {/* --- FOOTER ACTIONS --- */}
      <div className="p-4 border-t border-forest-200 bg-sand-100 flex justify-between items-center">
        <button
          onClick={handleAddChild}
          className="flex items-center gap-2 px-3 py-2 rounded-md bg-forest-600/90 hover:bg-forest-600 text-white text-sm font-medium transition-colors"
        >
          <Plus size={16} />
          Add child
        </button>
        <button 
          onClick={handleDelete}
          className="text-red-500/80 hover:bg-red-100/50 p-2 rounded-md flex items-center gap-2 text-sm font-medium transition-colors"
        >
          <Trash2 size={16} />
          Delete Node
        </button>
      </div>

    </div>
  );
}
