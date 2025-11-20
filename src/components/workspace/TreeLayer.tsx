'use client';

import React from 'react';
import { useForestStore } from '@/store/useForestStore';
import { motion, AnimatePresence } from 'framer-motion';

// --- 共享的物理动画配置 (确保文字和气泡同步) ---
const springConfig = {
  type: "spring",
  stiffness: 120,
  damping: 15,
  mass: 0.8
};

const Bubble = ({ node, isFocused, onClick, x = 0, y = 0, size }: any) => (
  <motion.div
    layoutId={node.id}
    onClick={(e) => { e.stopPropagation(); onClick(node.id); }}
    initial={{ scale: 0, opacity: 0 }}
    animate={{ 
      scale: 1, 
      opacity: 1,
      x: x, 
      y: y,
      // 确保 zIndex 也是由动画驱动的，防止层级突变
      zIndex: isFocused ? 20 : 10 
    }}
    // 2. 悬停状态 (关键修复)
    // 不要用 Tailwind 的 hover:scale，改用 whileHover
    // 这样 Framer Motion 会完美混合 x,y 和 scale
    whileHover={!isFocused ? { 
      scale: 1.05, 
      zIndex: 15, // 悬停时微微抬起层级，防止被遮挡
      transition: { duration: 0.2 }
    } : {}}

    transition={{ 
      type: "spring", 
      stiffness: 120, 
      damping: 15 
    }}
    
    // 3. ClassName 清理
    // 删除了 `hover:scale-105` 和 `z-10/z-20` (移到 style/animate 里了)
    className={`absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center cursor-pointer`}
    style={{ width: size, height: size }}
  >
    {/* 视觉层 */}
    <div className={`
      rounded-full flex items-center justify-center transition-all duration-500
      ${isFocused 
        ? 'w-full h-full bg-forest-800/90 backdrop-blur-md shadow-soft border border-forest-900/20 text-sand-100' 
        : 'w-full h-full bg-forest-100/80 backdrop-blur-sm border border-forest-300/50 text-forest-800 shadow-glass hover:bg-white/90' 
      }
    `}>
      {isFocused && (
         <div className="absolute inset-3 rounded-full border border-sand-100/20" />
      )}
    </div>

    {/* 文字层 */}
    <div className="absolute pointer-events-none flex flex-col items-center text-center p-4 w-full">
      <span className={`
        font-serif leading-tight transition-colors duration-300
        ${isFocused 
            ? 'text-3xl font-medium tracking-tight text-sand-100 drop-shadow-sm' 
            : 'text-sm font-medium opacity-90 text-forest-900' 
        }
      `}>
        {node.title}
      </span>
      
      {isFocused && (
        <span className="mt-2 text-[10px] uppercase tracking-widest text-forest-300 font-sans">
          {node.children.length} Branches
        </span>
      )}
    </div>
  </motion.div>
);

export function TreeLayer() {
  const nodes = useForestStore((s) => s.nodes);
  const focusedId = useForestStore((s) => s.focusedNodeId);
  const setFocus = useForestStore((s) => s.setFocus);
  const toggleSidebar = useForestStore((s) => s.toggleSidebar);
  const isSidebarOpen = useForestStore((s) => s.isSidebarOpen);

  const focusedNode = nodes[focusedId];
  const parentNode = focusedNode?.parentId ? nodes[focusedNode.parentId] : null;
  const childrenNodes = focusedNode?.children.map(id => nodes[id]) || [];

  const handleNodeClick = (id: string) => {
    setFocus(id);
    toggleSidebar(true);
  };

  // 尺寸常量
  const CENTER_SIZE = 200;
  const CHILD_SIZE = 100;
  const ORBIT_RADIUS = 240;

  if (!focusedNode) return <div>Error: Node not found</div>;

  return (
    <div 
      className="w-full h-full relative overflow-hidden"
      onClick={() => parentNode && setFocus(parentNode.id)}
    >
      {/* 
         --- 1. 顶部提示文字 (现在也会跟着平移了) --- 
         使用 motion.div 替代 div，并应用相同的 animate 和 transition
      */}
      <AnimatePresence>
        {parentNode && (
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ 
              opacity: 0.5, 
              y: 0,
              x: isSidebarOpen ? -200 : 0 // <--- 关键：应用相同的平移
            }}
            exit={{ opacity: 0, y: -20 }}
            transition={springConfig} // <--- 关键：应用相同的物理参数
            className="absolute top-24 w-full text-center pointer-events-none z-0"
          >
            <div className="text-xs uppercase tracking-widest mb-2">Return to</div>
            <div className="text-xl font-bold">{parentNode.title}</div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 
        --- 2. 虚拟相机组 (气泡主体) --- 
      */}
      <motion.div 
        className="absolute left-1/2 top-1/2 w-0 h-0"
        initial={false}
        animate={{ 
          x: isSidebarOpen ? -200 : 0 
        }}
        transition={springConfig} // <--- 关键：应用相同的物理参数
      >
        <AnimatePresence mode="popLayout">
          
          {/* Center Node */}
          <Bubble 
            key={focusedNode.id}
            node={focusedNode}
            isFocused={true}
            onClick={() => {}}
            size={CENTER_SIZE}
            x={0}
            y={0}
          />

          {/* Children */}
          {childrenNodes.map((child, i) => {
            const total = childrenNodes.length;
            const angle = total === 1 
              ? Math.PI / 2 
              : (i / total) * 2 * Math.PI - Math.PI/2;
            
            const x = Math.cos(angle) * ORBIT_RADIUS;
            const y = Math.sin(angle) * ORBIT_RADIUS;

            return (
              <Bubble 
                key={child.id}
                node={child}
                isFocused={false}
                onClick={handleNodeClick}
                size={CHILD_SIZE}
                x={x}
                y={y}
              />
            );
          })}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}