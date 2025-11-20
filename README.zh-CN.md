# 🌲 MindForest

MindForest 是一款「双层导航」的可视化知识组织工具：树状结构负责主题深潜，图谱结构负责跨主题关联。它结合了 Tree View、Graph View 以及 Markdown 编辑面板，帮助你以更具沉浸感的方式构建和梳理知识森林。

---

## ✨ 核心特性

- **Tree ↔ Graph 双模式切换**：底部 Dock 使用 Framer Motion 动化切换 `TreeLayer`（围绕焦点节点轨道排布）与 `GraphLayer`（react-force-graph-2d 物理布局）。
- **节点编辑工作台**：`NodeEditorPanel` 以 Markdown + 预览双模式编写内容，并显示创建日期、ID、类型等元数据。
- **本地持久化**：Zustand + `persist` 中间件将节点树保存到 `localStorage`，即使离线也能继续编辑。
- **语义动画语言**：Tailwind CSS v4 + 自定义森林调色板（`src/app/globals.css`）打造玻璃拟态、柔和光晕与噪点纹理。
- **扩展友好的数据模型**：`ForestNode` 同时记录树形 `children` 与图形 `links`，便于未来接入多种布局/同步策略。

---

## 🧱 技术栈

- **Frontend**：Next.js 16 App Router、React 19、TypeScript
- **State**：Zustand + Immer + uuid
- **Animation & Canvas**：Framer Motion、react-force-graph-2d
- **UI 工具**：Tailwind CSS 4、tailwind-merge、lucide-react、React Markdown、react-textarea-autosize

---

## 📁 项目结构

```
src/
 ├─ app/                 # App Router，包含 layout.tsx / page.tsx / 全局样式
 ├─ components/
 │   └─ workspace/       # TreeLayer · GraphLayer · WorkspaceShell · NodeEditorPanel
 ├─ hooks/               # 复用 hooks（useDebounce）
 ├─ store/               # Zustand slices（useForestStore）
 └─ types/               # 共享类型定义（forest.ts）
public/                  # 静态资源与预览图
```

---

## 🧭 Workspace 导览

| 区域 | 说明 |
| --- | --- |
| `src/components/workspace/WorkspaceShell.tsx` | 顶层客户端组件，负责 Dock 控件、视图切换、侧边栏动画与层管理。 |
| `TreeLayer.tsx` | 气泡化树视图，使用 Framer Motion `layoutId` 实现平滑缩放、悬停及父节点导航提示。 |
| `GraphLayer.tsx` | Force-directed 图谱，监听窗口尺寸，自动调整焦点节点与侧边栏偏移，渲染自定义 Canvas 节点。 |
| `NodeEditorPanel.tsx` | Markdown 编辑/预览、元数据、color token placeholder 与删除入口，使用 `useDebounce` 减少写入频率。 |
| `useForestStore.ts` | 提供节点 CRUD、聚焦、视图/侧边栏状态，使用 Immer 语义更新并落盘。 |

---

## 🚀 快速开始

1. **安装依赖**
   ```bash
   npm install
   # 或 pnpm install
   ```
2. **本地开发**
   ```bash
   npm run dev
   # 或 pnpm dev
   ```
   访问 `http://localhost:3000`，默认加载 `WorkspaceShell`。
3. **生产构建 / 预览**
   ```bash
   npm run build
   npm run start   # 在本地跑 prod server，发布前务必验证
   # 或 pnpm build / pnpm start
   ```
4. **代码质量**
   ```bash
   npm run lint    # ESLint + Next.js Core Web Vitals
   # 或 pnpm lint
   ```

> 推荐使用 Node 18+，并在提交前确保 dev server、build、lint 均无报错。

---

## 🗂️ 数据与状态

- `ForestNode` (`src/types/forest.ts`) 同时存储 `children`（树）与 `links`（图）引用，`type` 字段预设 `concept/fact/source/question`。
- `useForestStore` 提供：
  - `nodes`, `rootNodeId`, `focusedNodeId`, `viewMode`, `isSidebarOpen`
  - `setFocus`, `toggleView`, `toggleSidebar`
  - `addNode`, `updateNodeTitle`, `updateNodeContent`
- `persist` 仅 `partialize` 数据层（节点 & root），UI 状态在刷新后会重置，保持 predictable UX。

---

## 🧪 测试与质量

当前尚未提交自动化测试。按照团队规范，新增功能时请在 `src/**/__tests__` 下添加 Vitest + React Testing Library 测试文件（`*.test.tsx|ts`），并运行：

```bash
npx vitest run --coverage
```

在 PR 描述中补充手动验证步骤，直至自动化覆盖达到 ≥80% branch coverage。

---

## 🗺️ 路线图（节选）

1. **MVP**
   - Node CRUD、Tree View、缩放/聚焦过渡、本地持久化
2. **Alpha**
   - Graph View 加强、账户体系、云同步、Bulletin Board
3. **Beta**
   - 多布局（Pythagorean / Radial / Flow）、AI 助手、社区互动（Fork / Upvote / Learning Paths）

---

## 🤝 贡献指南

1. 分支自 `main`，保持 rebase 干净历史。
2. 采用 present-tense commit（如 `feat: expand node inspector`），在 PR 中列出 build/lint/test 状态与相关截图。
3. UI 向 PR 附上交互录屏或静态图；涉及 breaking change 时需明显标注。

欢迎一起扩展 MindForest，让知识森林继续生长 🌿
