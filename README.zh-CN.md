<div align="center">

<img src="./assets/MindForest.png" alt="logo" width="40%" />

[English](README.md) | 简体中文

</div>

> **状态：停止维护 / 已归档。**  
> 开发已暂停。最新进展在 `refactor/v2`（L1–L3 场域 morph、agent harness H1–H3）。不再计划新功能或支持。欢迎 fork 与实验。

MindForest 是一款「双层导航」的可视化知识组织工具：树状结构负责主题深潜，图谱结构负责跨主题关联。它结合了 Tree View、Graph View 以及 Markdown 编辑面板，帮助你以更具沉浸感的方式构建和梳理知识森林。

**当前版本：** 0.1.0-alpha · 更新内容见 [CHANGELOG.md](CHANGELOG.md)。

## 🚀 快速开始（优先使用桌面端）

桌面端内置 Rust API 和 SQLite，后端是**必需的**。

1. 导出前端静态资源（在根目录执行）：
   ```bash
   npm run build
   rm -rf rust-mindforest/apps/.tauri-dist
   mkdir -p rust-mindforest/apps/.tauri-dist
   cp -R out/* rust-mindforest/apps/.tauri-dist
   ```
2. 构建或开发桌面端：
   ```bash
   cd rust-mindforest/apps/desktop
   cargo tauri build        # 打包
   # 或 cargo tauri dev     # 开发模式（期望 Next dev 运行在 13000 端口）
   ```
3. 启动应用：会自动在 `127.0.0.1:8787` 开启 Rust API，等待健康后加载现有 Topic 或创建 “My Forest”，数据写入 `~/Library/Application Support/com.mindforest.desktop/mindforest.db`（或 `DATABASE_URL`）。

**若 macOS 报 “已损坏”**，可先移除隔离属性：
```bash
xattr -dr com.apple.quarantine /Applications/MindForest.app
# 或在挂载前对 DMG 解除隔离：xattr -dr com.apple.quarantine MindForest.dmg
```

## ✨ 核心特性

- **Tree ↔ Graph 双模式切换**：底部 Dock 使用 Framer Motion 动化切换 `TreeLayer`（围绕焦点节点轨道排布）与 `GraphLayer`（react-force-graph-2d 物理布局）。
- **节点编辑工作台**：`NodeEditorPanel` 提供节点删除、子节点添加、行内路径（可点击跳转）、Write/Read 切换、前进/后退导航、可点击的连接标签和下拉式连接选择器，辅以元数据与 Markdown 编辑/预览。
- **本地持久化**：Zustand + `persist` 中间件将节点树保存到 `localStorage`，即使离线也能继续编辑。
- **语义动画语言**：Tailwind CSS v4 + 自定义森林调色板（`src/app/globals.css`）打造玻璃拟态、柔和光晕与噪点纹理。
- **扩展友好的数据模型**：`ForestNode` 同时记录树形 `children` 与图形 `links`，便于未来接入多种布局/同步策略。


## 🧱 技术栈

- **Frontend**：Next.js 16 App Router、React 19、TypeScript
- **State**：Zustand + Immer + uuid
- **Animation & Canvas**：Framer Motion、react-force-graph-2d
- **UI 工具**：Tailwind CSS 4、tailwind-merge、lucide-react、React Markdown、react-textarea-autosize


## 📁 项目结构

```
rust-mindforest/         # Rust 工作区：domain、storage（memory/postgres/sqlite）、API、桌面端
  ├─ crates/             # 领域模型与存储实现
  ├─ apps/api/           # Axum HTTP API（topics/nodes）
  └─ apps/desktop/       # Tauri 桌面封装（内置 API + SQLite）
src/
 ├─ app/                 # App Router，包含 layout.tsx / page.tsx / 全局样式
 ├─ components/
 │   └─ workspace/       # TreeLayer · GraphLayer · WorkspaceShell · NodeEditorPanel
 ├─ hooks/               # 复用 hooks（useDebounce）
 ├─ store/               # Zustand slices（useForestStore）
 └─ types/               # 共享类型定义（forest.ts）
public/                  # 静态资源与预览图
```


## 🧭 Workspace 导览

| 区域 | 说明 |
| --- | --- |
| `src/components/workspace/WorkspaceShell.tsx` | 顶层客户端组件，负责 Dock 控件、视图切换、侧边栏动画与层管理。 |
| `TreeLayer.tsx` | 气泡化树视图，使用 Framer Motion `layoutId` 实现平滑缩放、悬停及父节点导航提示。 |
| `GraphLayer.tsx` | Force-directed 图谱，监听窗口尺寸，自动调整焦点节点与侧边栏偏移，渲染自定义 Canvas 节点。 |
| `NodeEditorPanel.tsx` | 行内路径 + Write/Read 切换、前进/后退导航、可点击连接标签、下拉搜索链接、元数据与去抖保存。 |
| `useForestDataStore.ts` / `useWorkspaceUIStore.ts` | 数据层 CRUD 与持久化，UI 层的聚焦/视图/侧边栏状态及导航历史（`goToNode`/`goBack`/`goForward`）。 |


## 🚀 快速开始

1. **安装依赖**
   ```bash
   npm install
   # 或 pnpm install
   ```
2. **启动 Rust API（写入真实数据必需）**
   ```bash
   cd rust-mindforest
   DATABASE_URL="sqlite://$HOME/Library/Application Support/com.mindforest.desktop/mindforest.db" \
   API_ADDR=127.0.0.1:8787 \
   cargo run -p api
   ```
3. **本地前端开发**
   ```bash
   npm run dev        # 端口 13000
   # 或 pnpm dev
   ```
   访问 `http://localhost:13000`，默认加载 `WorkspaceShell`。
4. **生产构建 / 预览**
   ```bash
   npm run build
   npm run start   # 在本地跑 prod server，发布前务必验证
   # 或 pnpm build / pnpm start
   ```
5. **代码质量**
   ```bash
   npm run lint    # ESLint + Next.js Core Web Vitals
   # 或 pnpm lint
   ```

> 推荐使用 Node 18+，并在提交前确保 dev server、build、lint 均无报错。

## 🔗 后端（必需）

- Rust API 是必选项；桌面端在 `127.0.0.1:8787` 内置启动，前端默认指向这里。
- 如需单独运行 API（例如使用 Postgres），在 `rust-mindforest` 启动并设置：
  - `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8787`（或你的端口）
  - `NEXT_PUBLIC_REMOTE_TOPIC_ID=<topic-id>`（可选；不设置会自动选取/创建）
- 页面加载时会拉取远程 Topic 并持续同步增删改链路；若远程 ID 返回 404，会自动清空并重建。


## 🗂️ 数据与状态

- `ForestNode` (`src/types/forest.ts`) 同时存储 `children`（树）与 `links`（图）引用，`type` 字段预设 `concept/fact/source/question`。
- `useForestDataStore` 提供：
  - `nodes`, `rootNodeId`
  - `addNode`, `updateNodeTitle`, `updateNodeContent`
- `useWorkspaceUIStore` 负责 UI/聚焦：
  - `focusedNodeId`, `viewMode`, `isSidebarOpen`, 导航栈
  - `goToNode`, `goBack`, `goForward`, `toggleView`, `toggleSidebar`, `hydrateEditorDraft`
- `persist` 仅 `partialize` 数据层（节点 & root），UI 状态在刷新后会重置，保持 predictable UX。


## 🗺️ 路线图（节选）

1. **MVP**
   - Node CRUD、Tree View、缩放/聚焦过渡、本地持久化
2. **Alpha**
   - Graph View 加强、账户体系、云同步、Bulletin Board
3. **Beta**
   - 多布局（Pythagorean / Radial / Flow）、AI 助手、社区互动（Fork / Upvote / Learning Paths）


## 🤝 贡献指南

1. 分支自 `main`，保持 rebase 干净历史。
2. 采用 present-tense commit（如 `feat: expand node inspector`），在 PR 中列出 build/lint/test 状态与相关截图。
3. UI 向 PR 附上交互录屏或静态图；涉及 breaking change 时需明显标注。

欢迎一起扩展 MindForest，让知识森林继续生长 🌿
