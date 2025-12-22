'use client';

import React, { useMemo, useRef, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import type { ForceGraphMethods, LinkObject, NodeObject } from 'react-force-graph-2d';

import { useForestDataStore } from '@/store/useForestDataStore';
import { useWorkspaceUIStore } from '@/store/useWorkspaceUIStore';
import { buildGraphData } from '@/lib/layout/graphData';

// 1. Dynamic Import (SSR False)
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), {
  ssr: false,
  loading: () => <div className="text-forest-300 flex items-center justify-center h-full font-serif">Loading Graph Physics...</div>
});

type FGNode = NodeObject;
type FGLink = LinkObject;
type FGMethods = ForceGraphMethods;

export function GraphLayer() {
  const nodes = useForestDataStore((s) => s.nodes);
  const focusedId = useWorkspaceUIStore((s) => s.focusedNodeId);
  const goToNode = useWorkspaceUIStore((s) => s.goToNode);
  const toggleSidebar = useWorkspaceUIStore((s) => s.toggleSidebar);
  const isSidebarOpen = useWorkspaceUIStore((s) => s.isSidebarOpen); // 获取侧边栏状态

  // 遥控器 Ref (操作相机)
  const fgRef = useRef<FGMethods | undefined>(undefined);
  // 容器 Ref (监听尺寸)
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ w: 800, h: 600 });

  // 2. 数据转换
  const graphData = useMemo(
    () => buildGraphData(nodes) as unknown as { nodes: FGNode[]; links: FGLink[] },
    [nodes]
  );

  // --- 3. Ref 穿透模式 (解决依赖死循环的关键) ---
  const graphDataRef = useRef<{ nodes: FGNode[]; links: FGLink[] }>(graphData);
  useEffect(() => {
    graphDataRef.current = graphData;
  }, [graphData]);

  // 4. 窗口尺寸监听
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setDimensions({
          w: containerRef.current.offsetWidth,
          h: containerRef.current.offsetHeight
        });
      }
    };
    window.addEventListener('resize', updateSize);
    updateSize();
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  // --- 5. 核心相机逻辑 (自动居中 + 侧边栏偏移) ---
  useEffect(() => {
    const graphInstance = fgRef.current;
    // 必须确保有实例且有选中ID
    if (!graphInstance || !focusedId) return;

    // 从 Ref 中读取最新数据 (物理引擎已经计算了 x, y)
    const currentNodes = graphDataRef.current.nodes;
    const targetNode = currentNodes.find((n) => n.id === focusedId);

    // 卫语句：坐标必须有效
    if (targetNode) {
      const tx = targetNode.x ?? 0;
      const ty = targetNode.y ?? 0;
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
      
      // 目标缩放倍率
      const TARGET_ZOOM = 5;
      
      // 基础坐标
      let targetX = tx;
      const targetY = ty;

      // 偏移逻辑：
      // 如果侧边栏打开 (宽度400px)，视觉中心向左移动了 200px。
      // 我们需要把相机向右移，这样内容看起来就向左了。
      if (isSidebarOpen) {
        // 200px 转换为图表坐标单位
        const offsetInGraphUnits = 200 / TARGET_ZOOM; 
        targetX += offsetInGraphUnits;
      }

      // 执行平滑运镜 (1000ms)
      graphInstance.centerAt(targetX, targetY, 1000);
      graphInstance.zoom(TARGET_ZOOM, 1000);
    }
  }, [focusedId, isSidebarOpen]); // 依赖：切换节点 OR 切换侧边栏状态

  return (
    <div ref={containerRef} className="w-full h-full bg-transparent">
      <ForceGraph2D
        ref={fgRef as React.MutableRefObject<ForceGraphMethods | undefined>}
        width={dimensions.w}
        height={dimensions.h}
        graphData={graphData}
        
        // --- 物理引擎设置 ---
        // 预热 50 帧，防止初始加载时炸开
        warmupTicks={50}
        // 冷却设为 0，防止数据更新时节点乱跑
        cooldownTicks={0}

        // --- 视觉设置 ---
        backgroundColor="rgba(0,0,0,0)" 
        
        // 交互
        nodeLabel="name"
        nodeRelSize={6}
        onNodeClick={(node) => {
          if (!node.id) return;
          goToNode(String(node.id));
          toggleSidebar(true);
          // 点击时的动画由上面的 useEffect 接管，这里只需改状态
        }}
        
        // --- 节点渲染 (Canvas API) ---
        nodeCanvasObject={(node: FGNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
          // 安全检查，防止报错
          const x = node.x ?? NaN;
          const y = node.y ?? NaN;
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;

          const label = node.name;
          const fontSize = 14 / globalScale;
          const isFocused = node.id === focusedId;
          const r = isFocused ? 8 : 4; 

          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI, false);

          // A. 绘制光晕 (Shadow Blur)
          if (isFocused) {
            ctx.shadowColor = '#D47A5D'; // Accent Color
            ctx.shadowBlur = 30;         // 柔和发光
          }

          // B. 绘制节点主体
          ctx.fillStyle = isFocused ? '#182822' : '#557C68'; 
          ctx.fill();

          // C. 清除光晕 (防止污染后续绘制)
          if (isFocused) {
            ctx.shadowBlur = 0;
            ctx.shadowColor = 'transparent';
          }
          
          // D. 绘制焦点描边 (增加锐度)
          if (isFocused) {
             ctx.lineWidth = 1 / globalScale;
             ctx.strokeStyle = '#D47A5D'; 
             ctx.stroke();
          }

          // E. 绘制文字
          ctx.font = `${isFocused ? '600' : '400'} ${fontSize}px "Crimson Pro", serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = isFocused ? '#182822' : '#557C68';
           
          ctx.fillText(label, x, y + r + (6/globalScale));
        }}

        // 连线样式
        linkColor={() => '#CCD6D1'} // Forest-200
        linkWidth={1}
      />
    </div>
  );
}
