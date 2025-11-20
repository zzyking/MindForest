'use client';
// components/workspace/WorkspaceShell.tsx

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { PanelRight, Network, TreeDeciduous } from 'lucide-react';
import { useForestStore } from '@/store/useForestStore';

import { TreeLayer } from './TreeLayer';
import { GraphLayer } from './GraphLayer';
import { NodeEditorPanel } from './NodeEditorPanel';

export default function WorkspaceShell() {
  const viewMode = useForestStore((s) => s.viewMode);
  const isSidebarOpen = useForestStore((s) => s.isSidebarOpen);
  const toggleSidebar = useForestStore((s) => s.toggleSidebar);
  const toggleView = useForestStore((s) => s.toggleView); // 假设你有这个action

  // 侧边栏宽度常量
  const SIDEBAR_WIDTH = 400;

  return (
    <div className="h-screen w-screen overflow-hidden bg-forest-50 flex relative">
      
      {/* --- MAIN CANVAS AREA (Layer Container) --- */}
      {/* 使用 motion.div 来平滑过渡 padding */}
      <motion.div 
        className="flex-1 relative h-full transition-all ease-[cubic-bezier(0.25,0.1,0.25,1.0)]"
        initial={false}
        animate={{
          // Tree模式下：物理挤压 (增加 padding)，让 flex 布局自动居中到剩余空间
          // Graph模式下：不挤压 DOM (保持全屏)，我们通过相机移动来模拟挤压，这样性能更好
          paddingRight: (viewMode === 'tree' && isSidebarOpen) ? SIDEBAR_WIDTH : 0
        }}
        transition={{ duration: 0.5, ease: "easeInOut" }} // 与侧边栏动画同步
      >
        
        {/* Dock 菜单 (保持在屏幕底部中心，随 padding 自动移动) */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-50">
          <div className="flex items-center gap-1 bg-white/80 backdrop-blur-xl border border-white/20 shadow-glass p-2 rounded-2xl text-forest-800">
            <button 
              onClick={() => useForestStore.setState({ viewMode: 'tree' })}
              className={`p-3 rounded-xl transition-all ${viewMode === 'tree' ? 'bg-forest-100 text-forest-900' : 'hover:bg-forest-50/50 text-forest-400'}`}
            >
              <TreeDeciduous size={20} />
            </button>
            <div className="w-px h-4 bg-forest-200 mx-1" />
            <button 
              onClick={() => useForestStore.setState({ viewMode: 'graph' })}
              className={`p-3 rounded-xl transition-all ${viewMode === 'graph' ? 'bg-forest-100 text-forest-900' : 'hover:bg-forest-50/50 text-forest-400'}`}
            >
              <Network size={20} />
            </button>
            <div className="w-px h-4 bg-forest-200 mx-1" />
            <button 
              onClick={() => toggleSidebar()}
              className={`p-3 rounded-xl transition-all ${isSidebarOpen ? 'bg-sand-100 text-accent' : 'hover:bg-forest-50/50 text-forest-800'}`}
            >
              <PanelRight size={20} />
            </button>
          </div>
        </div>

        {/* Layers */}
        <div className="absolute -top-10 inset-0 w-full h-full">
            {/* Tree View */}
            <motion.div 
              className="absolute inset-0 w-full h-full"
              animate={{ opacity: viewMode === 'tree' ? 1 : 0, pointerEvents: viewMode === 'tree' ? 'auto' : 'none' }}
              transition={{ duration: 0.4 }}
            >
              <TreeLayer />
            </motion.div>

            {/* Graph View */}
            <motion.div 
              className="absolute inset-0 w-full h-full"
              animate={{ opacity: viewMode === 'graph' ? 1 : 0, pointerEvents: viewMode === 'graph' ? 'auto' : 'none' }}
              transition={{ duration: 0.4 }}
            >
               <GraphLayer />
            </motion.div>
        </div>

      </motion.div>

      {/* --- SIDEBAR --- */}
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.div 
            initial={{ x: '100%', opacity: 0.5 }} // 稍微加点透明度过渡
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0.5 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }} // 典型的 iOS 侧滑手感
            className="absolute right-0 top-0 bottom-0 z-50 h-full border-l border-forest-200 shadow-2xl"
            style={{ width: SIDEBAR_WIDTH }}
          >
            <NodeEditorPanel />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}