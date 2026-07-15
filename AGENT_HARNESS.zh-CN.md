# Agent Harness 设计

> 状态：**H1 已实现 + 已验证**（`app-core/src/context.rs`；注入 2026-06-11,真 provider 验证 + 余弦阈值加固 2026-07-15）；H2–H4 仍为设计。本文档是 `AGENT_HARNESS.md` 的中文版，描述应用内 agent 如何接入 vault——什么上下文进去、什么操作出来、这些操作如何落盘。实现下方 H1..H4 各阶段时请回头参照。两版若有出入，以英文版为准。
>
> H1 验证（真 provider + 真 embeddings）：模型确实消费这个块——当另一 topic 存在真正相关的节点时,它发出逐字 id 的跨 topic `link`(单 topic 的 node dump 绝不可能产出);无相关节点时正确地不链接。门槛达标。注意招牌的 `<semantic-neighbors>` 通道好坏取决于 vault 的稠密度:~25 节点 + 近乎空的第二 topic 下它大多渲染为空,这是正确的。余弦阈值(见下)是验证暴露出"垃圾节点落在 ~0.58 泛英文基线"后补的。

## 1. 为什么

今天 MindForest 里的 agent 是无根的。Provider 看到的只有用户的 prompt 和**单个**焦点节点的标题 + 正文，vault 的其余部分一概不可见。所以它无法：

- 提议一个与现有兄弟节点互补的新兄弟节点，
- 发现用户正在起草的概念上个月已经在别处写过了，
- 引用另一个 topic 里的相关节点，
- 把放错位置的节点移动到正确的子树。

输出的形状是对的（markdown、正确的节点类型），但从未被**接线**进 vault。Harness 管三件事：模型看到什么上下文、能调用哪些工具、这些调用如何落盘。今天第一件事做了一半，后两件完全没做。

## 2. 三层结构

### L1 — 结构化上下文注入

每次调用模型前，构建一段把焦点定位在 vault 中的前缀。

```xml
<vault-context>
  <focus topic="design-tokens" id="01HK…" type="concept" title="Color tokens">
    {正文前 200 字符}
  </focus>
  <ancestors>
    <node id="…" type="concept" title="Design system" summary="…" />
    <node id="…" type="concept" title="Visual language" summary="…" />
  </ancestors>
  <siblings>
    <node id="…" type="concept" title="Spacing tokens" />
    <node id="…" type="concept" title="Typography tokens" />
  </siblings>
  <children>
    <node id="…" type="example" title="Brand palette JSON" />
  </children>
  <links>
    <node id="…" topic="accessibility" type="fact" title="WCAG AA contrast" />
  </links>
  <semantic-neighbors>
    <node id="…" topic="rust-internals" type="concept" title="Pure-OKLCH palette generator" score="0.78" />
    …
  </semantic-neighbors>
  <recent-edits>
    <node id="…" topic="design-tokens" type="concept" title="Sand neutrals" />
  </recent-edits>
</vault-context>
```

用类 XML 而不是散文：各家 provider 都能干净地解析这种结构，闭合标签也杜绝了"模型续写未闭合块"的失败模式。硬性 token 预算（默认 **2000**，环境变量 `MINDFOREST_AGENT_CONTEXT_BUDGET` 可覆盖）。超出时按此顺序丢弃：

1. 先丢 `<semantic-neighbors>`
2. 再丢 `<recent-edits>`
3. 把 sibling / children / link 条目截到只剩标题
4. 永不触碰 `<focus>` 和 `<ancestors>`——那是脊柱

Skip-connection 通过 `<links>`（显式）+ `<semantic-neighbors>`（隐式）表达。两者都需要：用户自己的链接选择是最强的意图信号，嵌入向量负责捕捉他们还没来得及链接的部分。

`<semantic-neighbors>` 是**纯嵌入**的——走纯向量搜索,不是 RRF 融合的混合 `search`。融合会掺入词法 FTS 命中,给出的是 rank-based 分数,和相关性无关,没法拿来卡阈值;原始余弦可以。低于**余弦阈值**（`MINDFOREST_AGENT_NEIGHBOR_MIN_COSINE`,默认 **0.60**）的邻居被丢弃,embedder 不可用时该段直接为空,而不是退回词法噪声。这个阈值有必要,因为 EmbeddingGemma-300M 把任意两段英文都拉到 ~0.58 附近,没有它,一个垃圾/近空节点就会挤进来、在稀疏 vault 的小跨 topic 池里占主导(实测:真正相关的跨 topic 节点 ~0.69,stub 占位垃圾 ~0.58)。

### L2 — 工具化编辑

Agent 不再是文本生成器，而是编辑者。六个工具，刻意收窄：

| 工具 | 参数 | 返回 | 读/写 |
|---|---|---|---|
| `mf_read_node` | `id` | `Node` | 读 |
| `mf_search` | `query`, `k`（默认 8） | `[NodeSummary]`（FTS + 向量，RRF 融合） | 读 |
| `mf_create_node` | `parent_id`, `title`, `type`, `content` | `Node`（带新分配的 ULID） | 写 |
| `mf_patch_node` | `id`, `{title?, content?, type?}` | `Node`（更新后） | 写 |
| `mf_link_nodes` | `src_id`, `dst_id` | `void` | 写 |
| `mf_move_subtree` | `id`, `new_parent_id` | `Node` | 写 |

Provider 循环：`text → tool_use → tool_result → text → tool_use → … → end_turn`。后端把每个工具调用执行在 `ShadowForestService` 上（见 §4），而不是直接落盘。Shadow 分配真实形状的 ULID，使同一轮里后续的 `mf_create_node` 能引用先前创建的节点作为 `parent_id`。

### L3 — 代码库理解（渐进式，不做批量）

两类树，一条写路径。**概念树**是默认：模型通过 L2 写工具自行起草。**代码库树**用同样的方式生长——刻意*不做 importer*。批量导入（跑一条管线、stage 两千个节点、让用户审）违背产品的核心规则：每个 agent 轮次都是一个小而可审的修改集（`AGENT_FEATURE.md` §1）。树应该像理解一样生长：每轮一小撮节点，按需下钻。

一个新的**只读** L2 工具支撑这一切：

| 工具 | 参数 | 返回 | 读/写 |
|---|---|---|---|
| `mf_code_map` | `root`, `focus?`（子路径）, `budget?`（token 数） | 紧凑的结构摘要 | 读 |

摘要包含：模块/目录大纲、按度数排名的关键符号、每条都标注 `EXTRACTED`（import/调用语句）或 `INFERRED`（二次推断）的跨模块依赖边、以及可用时的聚类提示。只给聚合后的结构，绝不给原始文件 dump。

交互循环：用户聚焦一个节点，prompt "梳理 `rust/` 的结构" → agent 调用 `mf_code_map` → 提议 5–8 个 `concept` 子节点外加横切依赖的 `links`（每条 link 注明置信标签 + 证据）→ 用户在普通的 staged-diff 流程里审核 → 想要更深时下钻到某个子节点重复一轮。粒度是自调节的——树跟随用户理解的粒度，而不是 repo 的符号数量。"重导"问题也随之消解：树从第一次 accept 起就归用户所有；刷新过期子树只是又一轮普通的 patch 提议（再调一次 `mf_code_map`）。

同一工具接口背后的后端，按顺序：

1. **原生 tree-sitter 大纲**（v1）——一个小的 `code-map` crate，使用成熟的 Rust tree-sitter binding。从 Rust + TS/TSX 起步：MindForest 自己就是 dogfood repo。
2. **graphify 增强器**（可选，永不必需）——若目标 repo 里存在 `graphify-out/graph.json`，读取它获得更丰富的社区/边数据。我们借鉴 graphify 的精华——确定性抽取（模型永不亲自解析代码）、置信标签、聚合摘要——跳过不合适的部分：批量管线、Python 运行时依赖、强制的 community→树映射（树的形状由 agent + 用户决定；聚类只是提示）。

其他来源的适配器（PDF、网页）以后走同样的形状：一个只读的摘要工具，喂给普通的 propose-review 轮次。

## 3. 单轮数据流

```
focus(node X, topic T)
   │
   ▼
ContextBuilder            app-core
   经 storage-fs 读取 X + 祖先 + 兄弟 + 子节点 + 出向 links
   经 embed crate 嵌入 X.content（按内容哈希缓存）
   查询 index-sqlite 取语义近邻
   格式化 <vault-context> 块，应用预算
   │
   ▼
AgentProposer.stream      agent
   system  = base_persona + <vault-context>
   tools   = [mf_read_node, mf_search, mf_create_node, …]
   │
   ▼
agent crate 内的工具循环
   text 块        ──► SSE "text"
   tool_use       ──► SSE "tool_call_pending"
                      后端分发给 ShadowForestService
                      结果    ──► 作为 tool_result 回给 provider
                      同时    ──► SSE "staged_diff"
   stop_reason="end_turn" ──► SSE "done"
   │
   ▼
DraftOverlay（web）
   展示助手文本 + staged-diff 列表
   用户按调用或按批 accept/reject
   accept ──► POST /v1/agent/staged/:turn_id/accept
              后端把 staged 写入一次性重放到真正的 ForestService
   reject ──► POST /v1/agent/staged/:turn_id/reject（丢弃 shadow）
```

## 4. 已定的决策

- **多个窄工具，而非一个多态的 `apply(op)`。** 在 OpenAI 和 Anthropic 两边，模型调用窄工具都更可靠。代价是六份工具定义而不是一份；收益是格式错误的参数显著减少。
- **经由 shadow service 暂存。** 写操作落在 `ShadowForestService` 上（一个内存中的 journal 覆盖层，读穿透到真正的 `ForestService`）。用户 accept 时把 journal 在一个事务里冲刷落盘；reject 则丢弃。这是本文档最重要的一个决定——没有暂存，每个 agent 轮次都可能在磁盘上留下半套变更。
- **Shadow 分配真实 ULID。** 这样 `mf_create_node` 的返回值可以作为同一轮里后续 `mf_create_node` 的 `parent_id`，模型的下游引用是稳定的。
- **Provider 抽象留在 agent crate。** 工具 schema 是一个带 `schemars::JsonSchema` derive 的 Rust enum。`anthropic` 和 `openai` 适配器各自翻译到自己的 wire 格式。不手写重复的 JSON schema。
- **扩展现有 SSE，不加新端点。** `/v1/agent/propose` 上的新事件：`tool_call_pending`、`tool_result`、`staged_diff`。已有的 `text` 和 `done` 不变。暂存需要两个新端点：`/v1/agent/staged/:turn_id/{accept,reject}`。
- **暂不做跨轮持久记忆。** 单个 prompt 内的多轮对话（P4-LT-5）保留。跨 prompt 的记忆是另一份设计。

## 5. 各 crate 的影响面

| Crate / 目录 | 变更 |
|---|---|
| `rust/crates/domain` | 新增 `ShadowForestService`——journal 覆盖层；trait 形状与 `ForestService` 相同。 |
| `rust/crates/embed` | 新增内容哈希 → 嵌入缓存。内存 LRU 还是 sqlite 落盘，benchmark 后再定；冷嵌入低于 50 ms 就不需要缓存。 |
| `rust/crates/index-sqlite` | 无新公开 API。ContextBuilder 使用现有的 `search_vec`。 |
| `rust/crates/agent` | 工具 schema enum（`AgentTool` + `AgentToolInput` derive `JsonSchema`）；两个 provider 适配器加 `tool_use`；新的流事件变体。 |
| `rust/crates/code-map` *（新，H4）* | `mf_code_map` 工具背后的 tree-sitter 大纲抽取；可选的 `graphify-out/graph.json` 读取器。除 `domain` 错误类型外不依赖其他 MindForest crate。 |
| `rust/crates/app-core` | 新 `ContextBuilder`；把 shadow + 工具分发接进 proposer 流程；暴露 `accept_staged_turn` / `reject_staged_turn`。 |
| `rust/apps/api` | 扩展 `/v1/agent/propose` 的 SSE 事件词汇表；新增两个暂存端点。 |
| `web/src/lib/api.ts` + `web/src/lib/types.ts` | 镜像新 SSE 事件与 staged-diff payload。 |
| `web/src/features/agent/DraftOverlay.tsx` | "Pending changes" 区：每个工具调用一行 diff（按操作配图标、标题、类型 chip、正文 diff、单条 accept/reject），footer 加 accept-all/reject-all。 |

## 6. 阶段划分

**H1 — 只有上下文，没有工具。** 实现 `ContextBuilder` 并注入 `<vault-context>`。`AgentProposer` 签名不变。**验收门槛**：原计划的"加兄弟节点看标题是否避重"其实是弱测试——请求体本就把整个 topic（含兄弟）dump 进去了,避重并不能隔离 L1。真正能隔离 L1 的信号：当**另一** topic 里存在真正相关的节点时,agent 发出跨 topic 的 `link`,用的是只可能在 `<semantic-neighbors>` 里见过的 id(dump 是单 topic 的)。这就是已跑通并通过的测试(2026-07-15)。如果 L1 单独无法明显提升输出质量，就停——H2/H3 也救不回来。

**H2 — 只读工具。** 加 `mf_read_node` + `mf_search`。Provider 可以自行决定深挖。无变更操作。UI 不变——仍然只是文本提案。

**H3 — 写工具。** `mf_create_node` / `mf_patch_node` / `mf_link_nodes` / `mf_move_subtree`。Shadow service。DraftOverlay 为 staged-diff UI 重新设计。这是 harness 里最大的单次交付；其余都是管线。

**H4 — `mf_code_map` 只读工具（PDF/网页更晚）。** 在 `mf_code_map` 工具接口后面交付原生 tree-sitter 大纲后端（Rust + TS/TSX 先行）；存在 `graphify-out/graph.json` 时作为可选增强器读取。**没有新 UI、没有 importer**——代码库树和概念树走同一条 prompt bar → staged-diff 循环，每轮一个子树。验收门槛：指向 MindForest 自己的 repo 长出一个结构 topic；提议的 `links` 必须引用带 `EXTRACTED` 证据的真实跨 crate 依赖。

H2 没做实之前不要上 H3。模型在不能先 `mf_read_node` 确认自己将要破坏什么的情况下，会对变更操作变得鲁莽。

## 7. 开放问题

- **Persona 块。** vault 特定的 persona（"你是为一位重视……的单一用户服务的策展人"）还是通用的？默认通用，以后暴露到 `AgentSettings`。
- **嵌入缓存位置。** 内存 LRU 更简单；sqlite（放 `index-sqlite`）能跨重启存活。先 benchmark——如果冷启动重嵌入焦点低于 50 ms 就无所谓。
- **冲突解决。** 用户在轮次中途编辑了焦点节点时，对过期状态的 accept 必须拒绝。轮次开始时对焦点算内容哈希；accept 时复查。若发散则提示"节点已被你修改，请重跑 agent"。
- **成本上限。** 每轮最大工具调用数（提案：20）。没有上限，一个糟糕的 prompt 可能失控。
- **流式顺序。** `tool_use` 块可能与文本交错到达。UI 必须按叙述顺序保持它们。
- **工具结果的冗长度。** 完整 `Node` payload 很大；一轮做十次 `mf_read_node` 上下文就膨胀了。可能需要 `mf_read_node(id, fields=[…])` 变体。
- **`mf_code_map` 结果预算。** 一次工具结果里塞多少结构才不至于挤占整轮？提案：默认 1500 token 摘要，带 `budget` 参数；按度数排名截断（先丢低度数符号，永不丢模块大纲）。需要对着 MindForest repo 的真实轮次调参。
- **代码图谱的时效性。** 工具实时读 repo，但已 accept 的树节点是某一时刻的快照。便宜的 v1：在代码衍生节点的正文尾部盖上 repo 的 commit hash 戳，至少让"这张图是三周前的"可见。自动检测漂移留作后续。
- **语言铺开。** 每加一门语言就多一个 tree-sitter grammar 依赖。Rust + TS/TSX 先行（dogfood），再看需求。graphify 增强器路径同时为装了它的用户覆盖冷门语言。

## 8. 范围之外

- 多 vault 会话
- 在线检索（web-search 工具）
- 后台 agent 循环——agent 只在用户 prompt 时运行
- 语音输入
- 跨 prompt 持久记忆（另一份设计）
