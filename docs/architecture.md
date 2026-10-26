# 架构设计

## 核心问题

CodeGraph 的 MCP 服务用**进程 cwd** 决定"当前项目"。DSH 是长时间运行的单一宿主进程，插件配置又是 profile 级的（全局），这两个模型不匹配。

三种可能的解法：

| 方案 | 做法 | 问题 |
|---|---|---|
| A. 每次查询传 `projectPath` | 单进程，中立 cwd，靠参数指定项目 | 需要模型每次记得传参；无法做到"自动" |
| B. 每项目一个 server 实例 | 按项目 spawn 独立进程，cwd 指向项目根 | ✅ 采用 |
| C. 改 DSH 支持 MCP roots | 让 DSH 通过 MCP 标准 `roots/list` 上报工作区 | 需要改 DSH 核心，插件做不到 |

**采用 B**。理由：CodeGraph 支持被多次实例化（每个进程独立；daemon 按项目路径 hash 出独立命名管道），且这是它原生的使用模型。

> 补充：方案 C 是更干净的长期解法。实测 DSH 的 `@deepseek-ai/dsh-mcp-client` 声明 `capabilities: {}`，不声明 roots，CodeGraph 因此收不到工作区信息，只能退回 cwd。这属于 DSH 上游的能力缺口，可另行提案。

## 整体结构

```
┌──────────────────────────────────────────────────────────┐
│ DSH Host 进程                                             │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ 本插件 (codegraph-project)                           │ │
│  │                                                      │ │
│  │  pool: Map<projectRoot, ProjectHub>                  │ │
│  │  sessionProjects: WeakMap<agent, projectRoot>        │ │
│  └──────────────┬───────────────────────────────────────┘ │
│                 │                                         │
│    ┌────────────┴────────────┐                           │
│    ▼                         ▼                           │
│  ProjectHub(2dgis-f)      ProjectHub(open-code-review)   │
│    refs=2                   refs=1                       │
│    │                         │                           │
└────┼─────────────────────────┼───────────────────────────┘
     │ ctx.subprocess          │ ctx.subprocess
     ▼                         ▼
 codegraph 子进程 #1       codegraph 子进程 #2
 (cwd=2dgis-f)            (cwd=open-code-review)
     │                         │
     ▼                         ▼
 .codegraph/codegraph.db   .codegraph/codegraph.db
```

**工具注册在各自 agent 的 scope 上**，不经过全局注册表：

```
agent A 的 scope          agent B 的 scope         agent C 的 scope
  └ mcp__codegraph__…       └ mcp__codegraph__…      (无工具)
       │                         │
       ▼                         ▼
  ProjectHub(2dgis-f)      ProjectHub(2dgis-f)      （无索引，什么都不注册）
```

## 数据流

### 1. 会话创建

```
agent/created（serial + await 派发，监听器可 await）
    │
    ├─ 读 agent.session.header.cwd
    │
    ├─ locateIndex(cwd)
    │     │
    │     ├─ 'indexed'
    │     │     ├─ 同项目已有 ready 连接 → 立即注册工具（零延迟）
    │     │     └─ 首次连接 → await acquire（带 5s 超时降级）
    │     │           ├─ 成功 → 注册工具
    │     │           └─ 超时 → 注册 agent/pre-step 懒检测
    │     │
    │     └─ 其他状态 → 注册 agent/pre-step 懒检测
    │
    └─ （无任何状态需要清理：工具绑定在 agent.ctx 上，会话销毁自动注销）
```

### 2. 工具调用

```
模型调用 mcp__codegraph__codegraph_explore
    │
    └─ 直接路由到本会话绑定的 hub（工具定义在注册时已捕获 hub 引用）
         └─ hub.call(工具名, 参数)
```

**没有 guard，没有 routing 表，没有运行时拒绝。** 工具可见性本身由 scope 保证。

### 3. 会话中途建索引

```
用户在会话里执行 codegraph init
    │
    ▼
下一次 agent/pre-step（注册在该 agent 的 ctx 上，只对它触发）
    │
    ├─ locateIndex(cwd)
    ├─ 仍无索引 → next()
    └─ 发现索引 → await mount() → 注销这个 pre-step 监听 → next()
```

**注意时序**：`preStep` 里 `assemble()` 在 `pre-step` 派发**之前**执行（`app.asar:319835` vs `319837`）。所以在 `pre-step` 里注册的工具**不会进入本次请求**，而是**下一条消息**时可用。

这不是缺陷，是 DSH 的装配顺序；文档和验收措辞应按"下一条消息即可用"描述，而不是"立即可用"。

### 4. 会话销毁

```
agent/disposed
    └─ pool.release(projectRoot)     // refs-1，归零则关闭子进程
```

工具注册无需手动清理：`register()` 返回 `layers.effect(this.ctx, ...)`，注册在 `agent.ctx` 上，agent 销毁时自动注销。

## 关键设计决策

### 决策 1：工具按会话注册（不是全局注册 + guard）

**早期设计曾假设"DSH 不支持 agent 作用域工具"，该前提在当前版本已被证伪。**

**运行时证据**：子 agent 探测——Lead 会话可见 53 个工具（含 `spawn_teammate`、`wait_agent`、`team_task_*`），子 agent 可见 49 个（不含这些）。两者处于同一个 host 进程、同一个全局工具注册表。这证明工具可见性确实按会话装配。

**源码证据链**：

```js
// dsh-experimental-tool-agent-team（随发行版交付）
function install(agent, ctx, config) {
  const scoped = agent.ctx
  register(scoped.tools.register(defineTool({ name: 'spawn_teammate', ... })))
}
ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })
```

```js
// dsh-tools ToolRuntime
register(definition) {
  return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), ...)
}
ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope))

view(scope) {
  const layers = this.layers.chainLayers(scope)
  const own = this.layers.peek(scope)
  ...
  if (own !== void 0) for (const [name, definition] of own.tools.entries()) {
    visible.set(name, definition)     // ← scoped 层无条件可见
  }
}
```

`agent.ctx` 由 `createScope(loopCtx, agent)` 创建，scope key 就是 agent 对象本身；装配时传入的 scope 正是 `{ agent, scope: agent }`。**两者是同一个对象，所以 scoped 层必然被合并。**

**采用结果**：

| 机制 | 早期设计 | 现在 |
|---|---|---|
| 工具注册 | 全局注册表 + 引用计数 | 各自 `agent.ctx` |
| 会话级可见性 | `ctx.tools.guard()` 运行时拒绝 | scope 天然隔离 |
| 调用路由 | `routing: Map<agentId, projectRoot>` | 工具定义捕获 hub 引用 |
| 无索引会话 | 工具可见但被拒绝 | 工具根本不存在 |

**额外发现**：`restrict()` 对 scoped 注册**无效**（源码注释：`scoped registrations remain visible`）。这解释了早期实现为何绕不过这个限制——它可能试过 `restrict` 而非 scope 注册。

### 决策 2：一个项目一个子进程

虽然实测确认单个 CodeGraph 进程可通过 `projectPath` 参数查询多个项目，但本插件仍选择一项目一进程：

| 对比项 | 一项目一进程（采用） | 单进程 + projectPath |
|---|---|---|
| 与 CodeGraph 原生模型 | 一致（cwd 即项目） | 需要改写工具参数 |
| 工具参数 | 原样透传 | 必须注入 `projectPath` |
| 进程数 | N 个项目 N 个进程 | 恒定 1 个 |
| 风险 | 已知可行 | 长会话跨项目 watcher 未验证 |

**正确性优先于资源占用。** 项目数量有限（当前 3 个有索引）。

### 决策 3：子进程必须走 `ctx.subprocess`

**不能用 MCP SDK 自带的 `StdioClientTransport`**，它用 `node:child_process` 直接 spawn，子进程不受 DSH 管理。后果：插件 `disabled: true`、热重载、harness 退出时，CodeGraph 进程会残留。

走 `ctx.subprocess.spawn` 获得的保障：

1. 进程组管理（TERM → 宽限期 → KILL），Windows 上通过 Job Object 容器
2. 服务 dispose 时终止并等待所有受管进程
3. harness 退出时的同步终结器

### 决策 4：关闭时 stdin 优先

实测 CodeGraph 在 stdin EOF 后几毫秒内退出。

```
stdin.end() → 等待 graceMs + 2s → 未退出则 terminate() → 再等待
```

信号只作为卡死时的兜底。

### 决策 5：懒检测用 `agent/pre-step` 而非定时器

**早期设计用 `tools/pre-execute`，按会话注册后该钩子失效**——工具不存在时 `pre-execute` 不会触发。

改用 `agent/pre-step`，注册在**该 agent 自己的 ctx** 上：

```js
agent.ctx.on('agent/pre-step', (payload, next) => {
  if (indexAppeared()) { mount(agent) ; dispose() }
  return next()
})
```

依据：`agent/pre-step` 通过 `dispatch.waterfall` 派发，而 `dispatch = agentEvents(loopCtx, this)`，其 `waterfall` 实现是 `ctx.waterfall(carrier, name, ...)`——**carrier 就是 agent**，所以注册在 agent scope 上的监听器只对该 agent 触发。

优点：
- 不需要全局节流状态
- 挂载成功后立即注销监听，后续 step 零成本
- 不影响其他会话

代价：未索引会话每 step 两次 `stat`。可选加 2 秒节流。

### 决策 6：注入 CodeGraph 的 `instructions`

CodeGraph 的 `initialize` 响应带 6786 字节的完整 playbook（实测 1.6.2，两个真实项目
一致）。本插件**注入**它，注册为 per-agent 的 `systemPrompt` section。

详见 [instructions.md](instructions.md)。要点：

1. 这是 MCP 协议标准字段，DSH 官方 `dsh-mcp-client` 本来就会注入；本插件自建 transport，
   必须显式补这一步，否则整条链路断开
2. CodeGraph 因此把 installer 写进 `AGENTS.md` 的块**刻意写薄**，只覆盖子代理和非 MCP
   宿主——所以「靠 AGENTS.md」不是替代方案，而是这个断点造成的后果
3. 必须注册在 `agent.ctx`（不是顶层 `ctx`），否则会变成全局 section，让无索引会话也看到
4. 所有失败路径降级为「少一段提示」，绝不影响工具可用性

> 历史：本决策此前是「不注入」，依据是一份已被实测推翻的分析（见
> [instructions.md](instructions.md) 末节）。

### 决策 7：保留 `projectPath` 参数

CodeGraph 的 `codegraph_explore` 自带 `projectPath` 参数，可查询其他项目。**保留，不移除。**

理由：

- 隔离由"每会话绑定自己的进程 + scope 级工具注册"保证，与参数存在无关
- 它是 CodeGraph 的原生能力，移除等于改写上游工具契约，违背"只做适配"原则
- 跨项目查询（如查同仓库其他子项目）是真实需求

## 状态机

```
                 agent/created
                       │
                       ▼
                  locateIndex(cwd)
                       │
        ┌──────────────┼──────────────┬─────────────┐
        ▼              ▼              ▼             ▼
   'indexed'      'missing'    'no-cwd'     'not-a-project'
        │              │              │             │
        ▼              ▼              ▼             ▼
   连并注册工具   注册 pre-step   注册 pre-step  注册 pre-step
        │         懒检测          懒检测         懒检测
        ▼
   'ready' ──(连接失败)──> 'failed' ──(pre-step 重试)──> 'ready'
```

## 与既有实现的差异

参考了 [troytse/dsh-plugin-codegraph-project](https://github.com/troytse/dsh-plugin-codegraph-project) 的架构（MIT），本插件做了明确裁剪：

| 能力 | 它 | 本插件 | 理由 |
|---|---|---|---|
| npx 拉取 + 版本管理 | ✅ | ❌ | 用户已全局安装 CodeGraph |
| settings 命名空间 | ✅ | ❌ | 配置写在行配置即可 |
| 索引轮询（poll.js） | ✅ 250 行 | ❌ | 用 `agent/pre-step` 懒检测 |
| 诊断工具 | ✅ | ❌ | 日志足够 |
| 断线重连 | ✅ | ❌（首版） | 遇到实际崩溃再加 |
| 家目录保护 | ✅ | ✅ 保留 | 防止误认领 |
| git root 停止 | ✅ | ✅ 保留 | 防止认领祖先仓库 |
| 引用计数共享 | ✅ | ✅ 保留 | 同项目多会话共用一个进程 |
| **工具注册方式** | 全局 + guard + 路由 | **按会话 scope** | 平台能力已可用，更简单更隔离 |

估算代码量：约 550 行（不含测试）。
