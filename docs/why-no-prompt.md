# 不注入系统提示词的理由

## 决定

插件**不**把 CodeGraph 的 `initialize` 响应中的 `instructions` 注入系统提示词。

## 背景

CodeGraph 的 MCP server 在 `initialize` 响应里返回一段 **6,718 字符**的使用指引。DSH 官方的 `@deepseek-ai/dsh-mcp-client` 会自动把它加入系统提示词，但本插件自建 transport，**不会自动继承这一步**。

所以这是一个需要显式决策的点：要不要自己补上。

## 为什么不做

### 1. 工具 description 已经包含核心指引，而且必然进入提示词

实测 `codegraph_explore` 的 `description` 是 **582 字符**，内容：

> **PRIMARY TOOL** — call FIRST for almost any question OR before an edit: how does X work, architecture, a bug, where/what is X, surveying an area, or the symbols you are about to change. Returns the verbatim source of the relevant symbols grouped by file in ONE capped call (Read-equivalent — treat the shown source as already Read; do NOT re-open those files), plus the call path among them. Query can be a natural-language question OR a bag of symbol/file names. **Usually the ONLY call you need** — more accurate context, in far fewer tokens and round-trips than a search/Read/Grep loop.

这段已经说清了：

- 什么时候用（几乎任何问题、改代码前）
- 它与 Read 等价（不要重复读）
- 一次调用通常就够
- 查询词可以是自然语言或符号名

**工具 description 是工具定义的固有部分**，DSH 组装工具列表时必然把它给模型看。这部分信息不需要插件做任何事。

### 2. 项目级提示词的正确位置是项目的 `AGENTS.md`

DSH 按目录加载指令文件。机制（`app.asar:316375`）：

> 第一次请求包含一条持久基线消息：先是用户全局指令链——`$DSH_HOME/AGENTS.md`，然后是 `<agentsHome>/AGENTS.md`——再按从宽泛到具体的顺序包含项目指令链：**从项目根目录到会话工作目录的每个目录中所有现有候选文件**。

默认候选：`AGENTS.md`、`CLAUDE.md`，另有 `AGENTS.local.md`、`CLAUDE.local.md` 作为本地覆盖。项目根标记默认 `.git`。

**如果某个项目希望模型优先用 CodeGraph，正确做法是在该项目的 `AGENTS.md` 里写**：

```markdown
## CodeGraph

本仓库已建立 `.codegraph/` 索引。理解代码前先用 `mcp__codegraph__codegraph_explore`，
不要先 grep 或逐个读文件。
```

好处：

- 提示词**跟着项目走**，符合"项目级"的整体设计
- 不同项目可以有不同引导强度
- 进 git，可 review、可版本控制
- 插件不需要维护提示词内容，避免"插件版本与 CodeGraph 版本不一致"
- 用户能看到并修改

### 3. 6,718 字符的 instructions 与 description 高度重叠

读过全文，`instructions` 的主要内容：

| 内容 | 是否已由 description 或 AGENTS.md 覆盖 |
|---|---|
| 什么时候用 | ✅ description |
| 与 Read 等价 | ✅ description |
| 查询构造技巧 | ⚠️ 进阶，description 未覆盖 |
| 反对做法（不要先 grep） | ✅ description |
| 索引新鲜度标记含义 | ⚠️ 进阶 |
| 动态派发跳转说明 | ⚠️ 进阶 |

**未覆盖的部分都是"进阶用法"，不是"能否用起来"的必要条件。** 而且它们的使用频率低，占用却是每次请求的成本。

### 4. 插件不该判断"该不该注入"

如果插件注入，它会面临两个问题：

- **无法知道项目 `AGENTS.md` 里有没有写**，可能造成重复或冲突
- **无法知道用户是否希望它注入**（有人可能觉得 2000 token 很贵）

做成配置项默认开启是一种折中，但增加了配置面；做成默认关闭又等于没做。**最稳妥的是不做，把决定权留给项目 `AGENTS.md`。**

## 补救阶梯

如果实际使用中发现模型用不好 CodeGraph，按此顺序处理：

1. **先在项目的 `AGENTS.md` 里补两句**（零代码改动，且最符合项目级语义）
2. 如果多个项目都需要相同内容，说明是共性问题
3. 再考虑加配置项 `injectInstructions: z.boolean().default(false)`

## 一个澄清

**"不注入"不等于"模型不知道有 CodeGraph"。** 完整链路是：

```
插件注册工具
    └─ 工具定义含 name + description（582 字符，含核心指引）
         └─ DSH 组装工具列表时必然包含它
              └─ 模型看到工具及其用途

用户项目 AGENTS.md（可选）
    └─ "本项目优先用 codegraph_explore"
         └─ DSH 按目录加载，进入系统提示词
              └─ 项目级引导到位
```

**插件的工作是"让工具在对的项目上可用"，不是"教模型用工具"。**

## 代价与接受

不注入 instructions 意味着：

- 模型可能不会用某些进阶技巧（比如利用新鲜度标记判断索引是否过期）
- 首次使用可能需要一两轮试探

**接受这个代价**，因为：

- 核心用法已由 description 覆盖
- 进阶技巧可以在项目 `AGENTS.md` 里按需补充
- 每次请求省下约 2000 token
