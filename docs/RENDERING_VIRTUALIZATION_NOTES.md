# 渲染窗口化 / 虚拟化 — 待评估的两个点

## 背景

对比 Obsidian 与 Typora 渲染长文档的体验差异得到的启发：Obsidian 流畅的根本原因不只是编辑器内核，而是"只渲染视口/焦点附近的内容，其余部分不参与实时排版"这一原则。Typora 则是把整篇文档持续渲染成一棵完整 DOM 树，文档越长、内容越密（表格/公式/高亮），重排开销越明显。

MindForest 在架构层面已经部分吃到了这个原则的红利：

- **Write 模式**：`web/src/features/editor/CodeMirrorView.tsx` + `livePreviewExtensions` 基于 CodeMirror 6，天然做视口窗口化渲染，长节点在编辑态不会卡。
- **数据模型**：知识被拆成一个个独立 node 文件而不是一篇长文档，从源头上规避了"单文档越写越长越卡"的问题。
- **TreeLayer**：`web/src/features/tree/TreeView.tsx:268` 的 `children.map` 只渲染当前 focus 节点的子节点/父节点/链接，不是一次性画出整片森林——以 focus 为中心窗口化，和 CM6 的"以视口为中心窗口化"是同一原则的另一种实现。
- **ForestView**：`web/src/features/forest/ForestView.tsx` 用 sigma.js + graphology 做 canvas 渲染，不是每个节点一个 DOM 元素，天然规避了大规模节点场景下的 DOM 膨胀问题。

以下两处是笔记记录时**还没有**吃到这个原则红利的地方。2026-07-09 做了一轮测量与实现:**点二已落地虚拟化**(为 agent 批量生成子树的规模路径铺路),**点一经测量确认为理论风险、暂缓**。

---

## 点一：ReadView（react-markdown）没有窗口化渲染 — 已测量，暂缓

> **2026-07-09 测量结论**：抽样当前 vault 27 个 node 的正文长度（去 frontmatter），
> P50 = 473 字符、P95 = 679、**P99 / max = 911 字符（不到 1KB）**、mean = 441。
> 最大节点也不足 1KB，react-markdown 一次性解析这点量是亚毫秒级——触发条件
> （"整篇长文粘进单节点"）在当前数据里完全不成立。按"先测量再决策"原则暂缓，
> 不引入分块 / CM6 只读态的复杂度。真正触发（单节点 > ~50KB，或产品加入
> "导入长文自动拆分"的中间态）时再做。

**位置**：`web/src/features/editor/NodeEditor.tsx` 第 470-487 行 `ReadView`

```tsx
function ReadView({ content }: { content: string }) {
  ...
  return (
    <div className="prose prose-stone max-w-none text-base leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{content}</ReactMarkdown>
    </div>
  );
}
```

**问题**：切到 Read 模式时，`react-markdown` 把整个 `content` 一次性解析并渲染成完整 DOM 树，没有任何窗口化/懒渲染机制。Write 模式因为用 CodeMirror 6 天然免疫这个问题，Read 模式没有对应机制——这正是 Typora 式卡顿会复现的地方。

**触发条件**（目前大概率不成立，需要先验证再决定是否值得做）：
- 单个 node 的 `content` 长度是否存在异常大的情况（例如用户整篇粘贴长文章进一个节点，而不是按 MindForest 的设计拆分成多个节点）。
- 如果产品后续要支持"导入长文档自动拆分成多个节点"这类功能，拆分前的中间态或拆分失败的兜底路径可能会让单节点内容变得很长。

**建议的下一步（评估阶段，非立即实现）**：
1. 先量化：抽样看当前 vault 里 node content 的长度分布（P50/P95/P99），确认是否真的存在"超长单节点"的情况。如果所有节点都很短，这一项可以先搁置，避免过早优化。
2. 若确有需要，可选方向：
   - 对 `ReactMarkdown` 的渲染结果做分块（按 heading 或段落分块）+ `IntersectionObserver`/虚拟滚动只挂载可视区域附近的块。
   - 或者 Read 模式也复用 CodeMirror 6（只读态），保持 Write/Read 两种模式渲染管线一致，直接继承 CM6 的窗口化能力，避免维护两套渲染逻辑。

---

## 点二：Sidebar 节点树没有虚拟滚动 — 已实现（2026-07-09）

> **已落地**：`Sidebar.tsx` 的 `NodeTree` 现在把可见树（root + 已展开后代）
> 拍平成线性 DFS 列表，交给 `@tanstack/react-virtual` 的 `useVirtualizer`
> 只挂载可视窗口 + overscan(12)。折叠子树不进入列表（沿用原"折叠不 mount"
> 语义）。`NodeRow` 改为扁平展示行，缩进引导线因虚拟行落在连续累积偏移上而
> 保持连续。新增 focus 变化时 `scrollToIndex` 把焦点行滚入视口，并补了
> `role="tree"/treeitem"` + `aria-level`/`aria-expanded` 语义。
>
> **端到端验证**（Playwright 驱动真实 dev app）：601 节点合成树、列表总高
> 9744px（视口 652px）时 DOM 只挂载 48 行；scrollTop=0 与 scrollTop=5000 的
> 挂载行集合零重叠 → 离屏行确实卸载；行间最大间隙 0px → 引导线连续。真实
> 数据（25 节点）无 console 错误、视觉与改动前一致。
>
> 注意：主题列表（`topicList.map`）仍是全量渲染——典型场景是十几个 topic，
> 规模远小于节点数，暂不虚拟化。

**位置**：`web/src/ui/Sidebar.tsx`

**原始问题**：项目依赖里没有虚拟滚动库，Sidebar 对节点树做纯 DOM `.map()` 全量渲染，这是经典的"渲染所有 DOM 而不做视口窗口化"场景——和 Typora 的问题本质相同，只是发生在列表而非文档里。

**触发条件**：
- 单个 vault 的节点总数规模。如果目前典型场景是几十到几百个节点，这不是问题；如果未来涨到几千个节点（尤其是配合 LLM agent 批量生成子树的功能，见 `AGENT_FEATURE.md`），Sidebar 全量渲染会成为第一个变卡的地方。

**建议的下一步（评估阶段，非立即实现）**：
1. 先确认 `Sidebar.tsx` 具体的列表渲染方式（是否已经有分页/懒加载/折叠机制，还是纯 `.map()` 全量渲染），以及当前测试用 vault 的真实节点规模。
2. 若确认存在风险，引入 `@tanstack/react-virtual`（项目已用 TanStack Router，生态一致）对列表做窗口化渲染，只挂载可视区域 + overscan 内的行。
3. `ForestView` 已经用 canvas 渲染，不受此问题影响，不需要处理。

---

## 非目标 / 注意事项

- 两点都遵循**先测量再决策**（2026-07-09 已执行）：
  - **点一**：测量显示单节点内容 P99 < 1KB，是理论风险，按原则暂缓，不引入复杂度——三行相似代码好过过早的抽象，这里同理。
  - **点二**：虽然当前 27 节点规模下也不卡，但节点树是 agent 批量生成子树后**最先撞到规模上限**的地方（单 topic 可能上千节点），且递归树虚拟化一次做对后是稳定收益，故主动实现、为未来铺路。端到端验证确认窗口化生效且无视觉回归。
- 若后续点一也需要实现，参考上文两条可选方向（分块 + IntersectionObserver，或 Read 模式复用 CM6 只读态）。
