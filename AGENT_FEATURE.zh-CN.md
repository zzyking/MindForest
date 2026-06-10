# 应用内的 Agent — 功能设计

> 状态：设计提案。本文档是 `AGENT_FEATURE.md` 的中文版，是 `AGENT_HARNESS.md`（讲上下文注入、工具 schema、暂存、SSE 协议）的产品侧配套。这份文档讲**用户看到什么**：agent 出现在哪里、能被要求做什么、提案如何审核、设置里有什么、哪些行为被设计禁止。两版若有出入，以英文版为准。

## 1. 角色定位

MindForest 里的 agent 不是聊天伴侣。它是一名**初级知识工作者**——一只草稿手：在焦点节点接受一条小指令，产出一组具体可审的编辑，然后停下。用户是编辑，agent 是助手。

这个定位排除了：

- 只聊不改的 "ask me anything"
- agent 直接在用户文档里自由打字
- 没有 prompt 就自行行动的后台 agent 循环

同时确立了：

- agent 永远只提议；用户永远是那个 apply 的人
- 每个提案都可审、原子、可逆
- 沉默是默认态——一次会话的大部分时间，agent 是关着的

## 2. Agent 出现在哪里

五个 surface，按预期使用频率排序：

1. **Prompt bar（底部居中）。** 主入口。`/` 或 `Cmd+I` 聚焦，输入，回车。Bar 始终反映焦点节点。流式输出时收缩为一个图标 + 状态；完成后展开回来。
2. **DraftOverlay（右侧面板）。** 轮次开始时滑入。上方流式文本，下方 staged-edit 列表，单条 accept/reject + accept-all/reject-all。在被关闭前保持打开，给用户留足审核时间。
3. **节点级 "ask" 入口。** 焦点节点卡片上的火花图标按钮，提供一击式起手（"解释这个"、"加个子节点"、"找相关"）。每个都只是预填 prompt bar——同一条输入路径，没有特殊 UI。
4. **编辑器内联建议。** 写作时的 ghost-text 补全；Tab 接受。优先级较低——H3 之后再上。
5. **设置（`Cmd+,`）。** Provider、模型、persona、上下文预算、auto-accept 策略、活动日志（更晚）。

## 3. Agent 能被要求做什么

五类任务。同一个 prompt bar 驱动全部；agent 从指令里自己选对工具。没有按任务分的 UI 模式。

| 类别 | 示例 | 用到的工具 | 输出 surface |
|---|---|---|---|
| **Expand** | "给这个概念起草几个子节点" | `mf_create_node` × N | diff 卡片 |
| **Refine** | "把正文收紧到 200 字" | `mf_patch_node` | 带正文 diff 的卡片 |
| **Connect** | "vault 里还有什么和这个相关？" | `mf_search` + `mf_link_nodes` | 提议的 links + 引用片段 |
| **Restructure** | "这个放错 topic 了——移过去" | `mf_move_subtree`（+ patches） | 带 from→to 路径预览的卡片 |
| **Investigate** | "总结这棵子树" / "X 和 Y 的区别？" | `mf_read_node` + `mf_search`（只读） | 流式散文，无 diff |

代码库树不是第六个类别——它搭 **Expand**（"梳理 `rust/` 的结构"）和 **Investigate**（"embed 管线是怎么工作的？"）的便车，只多一个只读工具 `mf_code_map`（见 `AGENT_HARNESS.md` §L3）。同一个 prompt bar，同样的 staged-diff 审核，每轮一个子树。产品里任何地方都没有批量导入的 surface。

## 4. 交互形态

### 单轮流程

```
聚焦一个节点
  │
  ▼
在 prompt bar 输入指令  →  发送
  │
  ▼
overlay 打开，开始流式输出
  │
  ▼
文本出现在上方                 diff 卡片随工具调用落在下方
  │                                       │
  └─────────── 流结束 ─────────────────────┘
  │
  ▼
用户审核：
  ├─ accept all     → 后端把全部 staged 写入一次性事务落盘
  ├─ reject all     → 后端丢弃 shadow
  └─ 按卡片         → 只冲刷被接受的卡片（按顺序）
  │
  ▼
overlay 显示 accept 后摘要（"5 条中应用了 3 条"），Done 按钮
```

### 多轮

一轮结束后 overlay 保持打开。Prompt bar 重新聚焦。用户可以：

- 发追问——agent 能看到上一轮的文本 + 新指令
- 随时 accept/reject 上一轮的 staged 编辑
- 说"不对，换个方式"——上一轮的 staged 集合成为可丢弃的上下文，而不是盘上的事实

会话以 overlay header 里显式的 **Reset** 按钮（或关闭 overlay）为界。Reset 清空历史 + shadow。

### 错误状态

| 状态 | 行为 |
|---|---|
| 流停滞 > 10 s 无 token | overlay 显示 "Waiting on model…" 提示；取消按钮 |
| Provider 返回错误 | 在 overlay 内联展示（不用 toast——太容易错过） |
| 工具调用被 `ForestService` 校验拒绝 | 提案标记为 **failed** 并附原因；用户可跳过或追问 |
| Accept 失败（节点被用户改过） | 提案标记为 **failed**；提示在新状态上重跑 |
| 流中途取消 | 部分草稿保留作上下文；staged shadow 丢弃 |

### 空状态

- vault 还没有内容 → bar 提示：*"先创建一个 topic，agent 才有东西可干"*
- Provider 未配置 → bar 禁用；引导进 AgentSettings
- 纯本地模式（未来）→ bar 显示 "on device" 徽章

## 5. 信任与审核

可审性是中心设计约束。每条 staged 编辑必须一眼传达：

- **什么类型的变更。** 图标：➕ create / ✏️ patch / 🔗 link / ➡️ move。
- **哪个节点。** 标题 + 类型 chip + topic（跨 topic 时加徽章）。
- **改了什么。** `patch` 给正文 diff（红色删除线 + 绿色新增）；`create` 给完整提议正文；`link` 给两个端点；`move` 给 from→to 子树路径。
- **为什么。** 模型经 tool_use 输入附带的可选单行理由。淡色字显示在标题下方。

Accept 规则：

- **默认**：按卡片 accept。
- **Accept-all** 可用，但当 staged 集合超过 5 张卡片或包含任何 `mf_move_subtree` 时，由内联确认拦一道。
- **Auto-accept** 在设置里按操作类型逐项 opt-in（例如"分数高于 0.85 的语义近邻自动 link"）。

Reject 规则：

- Reject 无破坏性——staged 的工作丢失，vault 不受影响。
- **"Reject 并告诉我原因"** 打开一个反馈框；反馈预填进 prompt bar 供追问轮使用。

## 6. 设置

位于 `Cmd+,`（AgentSettings 面板）。三个区块 + 一个未来的第四区块。

### Provider 与模型

- Provider：Anthropic / OpenAI / OpenAI 兼容 / Stub
- 模型：带合理默认值的下拉框，支持自由填写覆盖
- API key：Keychain 支撑的掩码字段（已随 K-1..K-5 发布）
- Base URL：用于 OpenAI 兼容端点（本地 llama.cpp、vLLM 等）

### 行为

- **Persona**：textarea，设定语气。可选；默认为空。
- **上下文预算**：500..4000 token，默认 2000。
- **每轮最大工具调用数**：默认 20，硬上限 50。
- **近期编辑窗口**：多少个最近碰过的节点喂进 `<recent-edits>` 上下文（默认 5）。

### Auto-accept 策略

- 分数高于 X 的语义近邻 `mf_link_nodes` → 自动 link（默认关，建议 0.85）
- 只改标题的 `mf_patch_node` → 自动应用（默认关）
- 其余一切：永远 staged

### 活动日志（未来）

- 按轮日志：时间戳、prompt、调用的工具、accept/reject 结果
- "重放这一轮" / "再用这个 prompt"
- JSON 导出用于调试

## 7. Agent 绝不允许的行为

硬规则。在 harness 层强制执行（见 `AGENT_HARNESS.md` §4 与 §7），在这里以保证的形式呈现：

- 用户 accept 之前绝不写盘（shadow staging 是实现机制）。
- 绝不读写当前 vault 之外的内容。
- 工具调用绝不超过每轮上限。
- 绝不提议 `delete`。删除只能由用户发起——一条明确的安全边界。
- 绝不把焦点节点自己的正文放进 `<semantic-neighbors>`（会造成自引用的 RAG 循环）。
- 绝不发明 ULID。所有 ID 都来自 `mf_search` / `mf_read_node` 的结果或 shadow 里 `mf_create_node` 的返回值。

## 8. 第一版范围之外

- 语音 prompt
- Agent 互审（一个 agent 给另一个的提案打分）
- 定时 / 后台 agent 运行（"每周日总结这一周"）
- 跨 prompt 持久记忆（独立设计——见 harness 文档的开放问题）
- 多 vault 上下文

## 9. 长期形态

未来一年应该收敛到的样子：

- **默认在端上。** 复用驱动嵌入的那套 Swift sidecar 模式；本地 Llama 级模型处理常规任务。云端 provider 只在用户为某一轮显式选用更强模型时使用。
- **有日志、可重放。** 每一轮都活在审计日志里：prompt + 工具 + 结果 + 理由。用户可以对新的焦点重放任何过去的轮次。
- **风格透明。** Agent 的笔触（标题大小写、行文节奏、类型选择）受一份内容侧的 `DESIGN.md` 等价物约束——让 vault 在人类与 agent 的共同贡献下保持一致。

最后一点是野心所在：一年后翻阅 vault 时，你不应该分得出哪些节点是 agent 起草的、哪些是你写的——除非理由日志里写着。
