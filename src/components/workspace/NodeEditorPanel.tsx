'use client';

import React, { useState, useEffect } from 'react';
import { X, Eye, Edit3, Calendar, Hash, Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm'; // Adds support for tables, strikethrough, etc.
import TextareaAutosize from 'react-textarea-autosize';
import { format } from 'date-fns';

import { useForestStore } from '@/store/useForestStore';
import { useDebounce } from '@/hooks/useDebounce';

export function NodeEditorPanel() {
  const focusedId = useForestStore((s) => s.focusedNodeId);
  const nodes = useForestStore((s) => s.nodes);
  const updateNodeContent = useForestStore((s) => s.updateNodeContent);
  const toggleSidebar = useForestStore((s) => s.toggleSidebar);
  
  // Get the actual node object
  const node = nodes[focusedId];

  // Local state for inputs (for instant typing feedback)
  const [localContent, setLocalContent] = useState('');
  const [localTitle, setLocalTitle] = useState('');
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');

  // Sync local state when the focused node changes
  useEffect(() => {
    if (node) {
      setLocalContent(node.content || '');
      setLocalTitle(node.title || '');
    }
  }, [node?.id]); // Only reset when ID changes

  // Debounce saves to the global store (500ms delay)
  const debouncedContent = useDebounce(localContent, 500);
  const debouncedTitle = useDebounce(localTitle, 500);

  useEffect(() => {
    if (node && (debouncedContent !== node.content || debouncedTitle !== node.title)) {
      // We create a generic "updateNode" action in store, or use specific ones
      // For now, let's assume updateNodeContent handles content. 
      // You might need to add `updateNodeTitle` to your store.
      updateNodeContent(node.id, debouncedContent); 
      
      // TODO: Add updateNodeTitle(node.id, debouncedTitle) to your store
    }
  }, [debouncedContent, debouncedTitle]);

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
            onClick={() => toggleSidebar(false)}
            className="p-2 hover:bg-forest-200/50 rounded-full text-forest-500 transition-colors"
          >
            <X size={20} />
          </button>
        </div>
      </div>

      {/* --- SCROLLABLE CONTENT --- */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-8 py-8 max-w-3xl mx-auto">
          
          {/* Title Input */}
          <TextareaAutosize
            value={localTitle}
            onChange={(e) => setLocalTitle(e.target.value)}
            placeholder="Untitled Node"
            className="w-full text-4xl font-serif font-extrabold bg-transparent border-none focus:ring-0 resize-none placeholder:text-forest-300 text-forest-900 mb-4 leading-tight outline-none"
          />

          {/* Metadata Row */}
          <div className="flex gap-6 text-xs text-forest-500 mb-8 font-sans">
            <div className="flex items-center gap-1.5">
              <Calendar size={14} />
              {format(node.createdAt, 'MMM d, yyyy')}
            </div>
            <div className="flex items-center gap-1.5">
               ID: <span className="font-mono bg-forest-200/30 px-1 rounded text-forest-800">{node.id.slice(0,6)}</span>
            </div>
          </div>

          {/* Tabs: Edit vs Preview */}
          <div className="flex items-center gap-1 mb-6 bg-forest-200/30 w-fit p-1 rounded-lg font-sans">
            <button
              onClick={() => setMode('edit')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                mode === 'edit' ? 'bg-sand-100 shadow-sm text-forest-900' : 'text-forest-500 hover:text-forest-700'
              }`}
            >
              <Edit3 size={14} /> Write
            </button>
            <button
              onClick={() => setMode('preview')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                mode === 'preview' ? 'bg-sand-100 shadow-sm text-forest-900' : 'text-forest-500 hover:text-forest-700'
              }`}
            >
              <Eye size={14} /> Read
            </button>
          </div>

          {/* EDITOR AREA */}
          <div className="min-h-[400px]">
            {mode === 'edit' ? (
              <TextareaAutosize
                minRows={15}
                placeholder="Start typing your thoughts (Markdown supported)..."
                value={localContent}
                onChange={(e) => setLocalContent(e.target.value)}
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
        <div className="flex gap-2">
           {/* Placeholder for Color Picker */}
           <div className="w-6 h-6 rounded-full border border-neutral-200 cursor-pointer shadow-sm" style={{ backgroundColor: node.color }} />
        </div>
        <button className="text-accent hover:bg-accent/10 p-2 rounded-md flex items-center gap-2 text-sm font-medium transition-colors">
          <Trash2 size={16} />
          Delete Node
        </button>
      </div>

    </div>
  );
}
