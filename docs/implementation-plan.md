# 开发指南

> **这是唯一必读文档。** 自包含，读完即可开始实现。
> 其他文档是决策依据与调研记录，实现时不需要读，遇到疑问再查。

## 一、要做什么

一个 DSH Host 插件，把用户已安装的 CodeGraph 按**项目维度**接入。

**问题**：CodeGraph 的 MCP 服务只能从自己进程的 `cwd` 推断"当前项目"。DSH 的插件配置是 profile 级（全局），只能写死一个 `cwd`，换项目就**静默查询错误仓库**。

**解法**：读会话工作目录 → 定位 `.codegraph/` 索引 → 每个项目启动独立 CodeGraph 子进程 → 工具注册到该会话的 scope。

**不做**：不改 CodeGraph 源码、不内嵌运行时、不管理版本、不自动 init、不注入提示词。

---

## 二、架构（30 秒理解）

```
agent A scope ── mcp__codegraph__codegraph_explore ──→ ProjectHub(项目根1) ──→ codegraph 进程#1
agent B scope ── mcp__codegraph__codegraph_explore ──→ ProjectHub(项目根1) ──→ （共享上面那个进程）
agent C scope ──（无工具）                              （无索引，什么都不注册）
```

三条关键机制：

1. **工具注册在 `agent.ctx` 上** —— DSH 的模型工具列表按会话 scope 组装，所以无索引会话根本看不到工具，不需要运行时拒绝
2. **每个项目一个 CodeGraph 子进程** —— 进程 `cwd` 就是项目根，查询不需要额外参数
3. **子进程走 `ctx.subprocess`** —— 否则 `disabled` 或退出时会残留

---

## 三、目录结构

```
dsh-codegraph-project/
├── package.json
├── cordis.patch.yml
├── lib/
│   ├── index.js       ~150 行   装配
│   ├── locate.js      ~120 行   会话 cwd → 项目根
│   ├── pool.js        ~150 行   连接池 + 引用计数
│   ├── transport.js   ~180 行   MCP stdio（基于 ctx.subprocess）
│   ├── bridge.js      ~80 行    MCP 工具 → DSH 工具
│   └── config.js      ~30 行    配置 schema
├── scripts/probe.mjs            不经 DSH 的验证脚本
└── test/locate.test.js
```

---

## 四、逐模块实现

### 4.1 `config.js`

```js
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  enabled: z.boolean().default(true),
  serverName: z.string().pattern(/^[A-Za-z0-9_-]{1,32}$/).default('codegraph'),
  codegraphBin: z.string().default(''),
  codegraphArgs: z.array(String).default(['serve', '--mcp']),
  toolCallTimeoutMs: z.number().min(1).default(60000),
  connectTimeoutMs: z.number().min(1).default(5000),
  watchIntervalMs: z.number().min(0).default(2000),
})
```

**`toolCallTimeoutMs` 必须 `.min(1)`** —— `register()` 会校验，配成 0 或负数会抛 `TypeError`。

#### 可执行文件探测（关键，容易踩坑）

`codegraph` 在 Windows 上是 npm 的 `.cmd` 批处理，**不能直接 spawn**。而且 `subprocess.resolveExecutable('codegraph')` 会成功返回 `.cmd` 路径（因为 PATHEXT 含 `.CMD`），错误被推迟到 spawn 阶段。

探测逻辑：

```js
async function resolveArgv(subprocess, config) {
  // 1. 用户配置优先
  if (config.codegraphBin) {
    return [config.codegraphBin, ...config.codegraphArgs]
  }

  // 2. PATH 探测
  let resolved
  try {
    resolved = await subprocess.resolveExecutable('codegraph')
  } catch (e) {
    throw new Error(
      `codegraph not found on PATH. Install it (npm i -g @colbymchenry/codegraph) ` +
      `or set codegraphBin in this plugin's row config.`
    )
  }

  // .exe 直接用
  if (!/\.(cmd|bat)$/i.test(resolved)) {
    return [resolved, ...config.codegraphArgs]
  }

  // 3. .cmd → 从 npm 布局推导 node.exe + 入口脚本
  const prefix = dirname(resolved)          // .../npm
  const pkgRoot = join(prefix, 'node_modules', '@colbymchenry', 'codegraph')
  const platformPkg = join(pkgRoot, 'node_modules', '@colbymchenry',
    `codegraph-${process.platform}-${process.arch}`)
  const nodeExe = join(platformPkg, 'node.exe')
  const entry = join(platformPkg, 'lib', 'dist', 'bin', 'codegraph.js')
  if (existsSync(nodeExe) && existsSync(entry)) {
    return [nodeExe, entry, ...config.codegraphArgs]
  }

  // 4. 失败：错误信息必须可操作
  throw new Error([
    `cannot launch codegraph: ${resolved} is a .cmd shim and cannot be spawned directly.`,
    `Tried the npm layout at ${platformPkg} but did not find node.exe + lib/dist/bin/codegraph.js.`,
    `Set codegraphBin on this plugin's row config to the codegraph executable, for example:`,
    `  config:`,
    `    codegraphBin: C:\\path\\to\\node_modules\\@colbymchenry\\codegraph-<platform>\\node.exe`,
    `    codegraphArgs: [C:\\path\\to\\...\\lib\\dist\\bin\\codegraph.js, serve, --mcp]`,
  ].join('\n'))
}
```

**第 3 步依赖 npm 布局，是脆弱的**。注释里说明清楚，失败时给出可复制的配置示例。

---

### 4.2 `locate.js`

```js
export function locateIndex(cwd) → IndexLocation

// { state: 'indexed',       projectRoot, stopReason: 'index' }
// { state: 'missing',       stopReason: 'git-root' | 'filesystem-root' }
// { state: 'not-a-project', stopReason: 'empty-index' | 'home-directory' | 'index-unreadable', indexRoot? }
// { state: 'no-cwd' }
```

**算法**：从 `cwd` 向上遍历，每层检查 `.codegraph/`：

```
若 current/.codegraph 存在：
    列出内容
    ├─ 读不了              → not-a-project / index-unreadable（停止，不向上）
    ├─ 无 *.db             → not-a-project / empty-index（停止）
    └─ 有 *.db：
         ├─ 是家目录或根   → not-a-project / home-directory（停止）
         └─ 否则           → indexed，返回 current
若 current/.git 存在       → missing / git-root（停止）
current 已是文件系统根     → missing / filesystem-root（停止）
current = parent
```

**四条规则不能省**：

| 规则 | 原因 |
|---|---|
| `.codegraph/` 里必须有 `*.db` | CodeGraph 把 `daemon.pid`/`daemon.log`/`writer.pid` 也放这里，只有这些的目录不是项目 |
| 遇到 `.git` 停止 | 索引在仓库边界之上属别的仓库，不能认领 |
| 家目录/根不算项目 | 否则 `~/.codegraph/codegraph.db` 会让 `$HOME` 下所有会话认领它 |
| `.codegraph` 读不了就停 | 继续向上会把权限问题变成"服务了错误的代码库" |

**测试**（`mkdtemp` 造假目录树）：正常索引、只有 `daemon.pid`、家目录索引、遇到 `.git`、不可读目录。

---

### 4.3 `transport.js`

在 `ctx.subprocess` 上实现 MCP Transport。**不能用 MCP SDK 的 `StdioClientTransport`**（它用 `node:child_process`，进程不受 DSH 管理）。

```js
class ManagedStdioTransport {
  constructor({ subprocess, argv, cwd, env, graceMs, label })
  launch()                    // subprocess.spawn(...)，同步返回 handle
  async start()               // MCP 契约，内部调 launch()
  async send(message)         // 写一行 NDJSON 到 stdin
  async close()               // stdin.end → 等 → terminate → 等
  async waitForExit({timeoutMs})
  onmessage / onerror / onclose
  get running()
  get stderrTail()            // 最后 8KB，用于诊断
}
```

**spawn 调用**：

```js
const handle = subprocess.spawn({
  argv,
  cwd: projectRoot,
  stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  graceMs: 3000,
  env,
})
```

**stdout 处理**：NDJSON 流，按 `\n` 切分，注意跨 chunk 的行缓冲。`JSON.parse` 失败调 `onerror` 但不中断流。

**close（关键）**：

```js
async close() {
  if (this.closePromise) return this.closePromise
  this.closed = true
  this.closePromise = (async () => {
    try { this.handle.stdin?.end() } catch {}
    if (await this.waitForExit({ timeoutMs: this.graceMs + 2000 })) return
    try { this.handle.terminate() } catch {}
    await this.waitForExit({ timeoutMs: this.graceMs + 5000 })
  })()
  return this.closePromise
}
```

**实测**：CodeGraph 在 stdin EOF 后几毫秒退出，所以 stdin-first 是主路径，信号只是兜底。

**握手竞速**：把"进程已死"和"握手超时"区分开，报真实 stderr。

---

### 4.4 `pool.js`

```js
class ProjectHub {
  async connect()                   // 幂等，并发共享
  async call(rawName, args, exec)   // 调一次 MCP 工具
  retain() / release()              // 引用计数
  async close()
  tools()                           // 原始 MCP 工具列表
  subscribe(listener)               // tools/list_changed
}

class Pool {
  async acquire(projectRoot)                                // 加引用并连接
  async release(projectRoot)                                // 减引用，归零则关闭
  async connectWithTimeout(projectRoot, timeoutMs)          // 带超时
  get(projectRoot) / list() / closeAll()
}
```

**acquire 必须先 retain 再 await**，否则"连接过程中会话销毁"会误释放别人正在用的引用：

```js
async acquire(projectRoot) {
  const existing = this.hubs.get(projectRoot)
  if (existing) {
    existing.retain()
    try { return await existing.connect() }
    catch (e) { existing.release(); throw e }
  }
  const hub = new ProjectHub({ projectRoot, deps: this.deps })
  this.hubs.set(projectRoot, hub)
  hub.retain()
  try { return await hub.connect() }
  catch (e) {
    hub.release(); this.hubs.delete(projectRoot)
    await hub.close().catch(() => {})
    throw e
  }
}
```

**`connectWithTimeout` 的简化做法**（避免悬挂引用）：

```js
async connectWithTimeout(projectRoot, timeoutMs) {
  const existing = this.hubs.get(projectRoot)
  if (existing) return existing.connect()      // 已存在，不超时

  // 首次连接：先发起，超时则返回 undefined 让调用方走懒检测
  // 注意：超时后 acquire 仍在进行，它成功时会保留引用，
  // 所以这里不用 acquire，改成手动控制
  ...
}
```

**更简单**：首次连接直接 `await acquire()` 不加超时。理由：CodeGraph 本地启动 1–3 秒，`agent/created` 等这么久可以接受；真正慢的情况（冷缓存）才需要超时，而你已经全局安装，不存在冷缓存。

**首版不做断线重连。**

---

### 4.5 `bridge.js`

转换 MCP 工具定义为 DSH 工具。

**三个硬约束**：

1. **`parameters` 是属性 map，不是完整 JSON Schema**

```js
// DSH 内部：parameterSchemaSpecToJsonSchema(options.parameters)
//         → compilePropertyMap(spec)  → { type:'object', properties, required }
// 传完整 schema 会把 type/properties/required 当成参数名
```

2. **`output` 必须是 `{ schema, render }`**，`render` 是必需函数

3. **`timeoutMs` 必须为正数**

```js
export function toToolParameters(inputSchema) {
  const props = inputSchema?.properties ?? {}
  const required = new Set(inputSchema?.required ?? [])
  const out = {}
  for (const [name, spec] of Object.entries(props)) {
    out[name] = {
      type: spec.type ?? 'json',                    // 未知类型降级
      ...(spec.description ? { description: spec.description } : {}),
      ...(spec.default !== undefined ? { default: spec.default } : {}),
      ...(Array.isArray(spec.enum) ? { enum: [...spec.enum] } : {}),
      ...(required.has(name) ? { required: true } : {}),   // ← 属性级，不是根级数组
    }
  }
  return out
}

export function createBridgedTool({ publicName, rawName, description, inputSchema, hub, timeoutMs }) {
  return {
    name: publicName,
    description: description || `CodeGraph tool "${rawName}"`,
    parameters: toToolParameters(inputSchema),
    timeoutMs,
    output: {
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: { type: 'json' } },
          structuredContent: { type: 'json' },
        },
        additionalProperties: false,
      },
      render(_args, value) {
        const blocks = Array.isArray(value?.content) ? value.content : []
        const text = blocks
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text).join('\n')
        return [{ type: 'text', text: text || `[${rawName}] (no output)` }]
      },
    },
    async execute(args, exec) {
      const result = await hub.call(rawName, args ?? {}, exec)
      return {
        content: projectContent(result?.content, rawName),
        ...(result?.structuredContent === undefined
          ? {} : { structuredContent: result.structuredContent }),
      }
    },
  }
}
```

`projectContent`：只桥接文本块，其他类型转成诊断文本（**不要静默丢弃**）。

**CodeGraph 的 schema 极简**（实测）：3 个标量属性，无 `oneOf`、无嵌套、无 `format`。所以转换器 20 行足够。

**保留 `projectPath` 参数** —— 它在 `properties` 里，会自动被带过来，不做特殊处理。

---

### 4.6 `index.js`

```js
export const name = 'codegraph-project'
export const inject = ['subprocess', 'tools']
export const Config = RowConfig

export function apply(ctx, config) {
  if (!config.enabled) return

  const pool = new Pool({ ... })
  const sessionProjects = new WeakMap()   // agent → projectRoot（仅用于 release）
  const watchers = new WeakMap()          // agent → dispose

  // 会话创建
  ctx.on('agent/created', async ({ agent }) => {
    const cwd = agent.session?.header?.cwd
    const loc = locateIndex(cwd)
    if (loc.state !== 'indexed') { watchForIndex(agent, cwd); return }

    const existing = pool.get(loc.projectRoot)
    if (existing) { mount(agent, existing, loc.projectRoot); return }

    try {
      const hub = await pool.acquire(loc.projectRoot)
      mount(agent, hub, loc.projectRoot)
    } catch (e) {
      logger.warn(`codegraph unavailable for ${loc.projectRoot}: ${e.message}`)
      watchForIndex(agent, cwd)
    }
  })

  // 会话销毁
  ctx.on('agent/disposed', async ({ agent }) => {
    watchers.get(agent)?.(); watchers.delete(agent)
    const root = sessionProjects.get(agent)
    if (root !== undefined) await pool.release(root).catch(() => {})
  })

  // 卸载
  ctx.effect(() => () => pool.closeAll())

  function mount(agent, hub, projectRoot) {
    sessionProjects.set(agent, projectRoot)
    for (const tool of hub.tools()) {
      const publicName = `mcp__${config.serverName}__${tool.name}`
      try {
        // 注册在 agent.ctx 上：agent 销毁时自动注销，无需手动 dispose
        agent.ctx.tools.register(createBridgedTool({
          publicName, rawName: tool.name, description: tool.description,
          inputSchema: tool.inputSchema, hub, timeoutMs: config.toolCallTimeoutMs,
        }))
      } catch (e) {
        logger.error(
          `could not register ${publicName}: ${e.message}. ` +
          `This usually means another MCP server owns the "${config.serverName}" namespace. ` +
          `Set a distinct serverName on the codegraph-project row.`
        )
      }
    }
  }

  function watchForIndex(agent, cwd) {
    if (typeof cwd !== 'string' || cwd === '') return
    let lastCheck = 0
    const dispose = agent.ctx.on('agent/pre-step', async (payload, next) => {
      if (Date.now() - lastCheck < config.watchIntervalMs) return next()
      lastCheck = Date.now()
      const loc = locateIndex(cwd)
      if (loc.state !== 'indexed') return next()
      dispose(); watchers.delete(agent)
      const hub = await pool.acquire(loc.projectRoot).catch(() => undefined)
      if (hub) mount(agent, hub, loc.projectRoot)
      return next()
    })
    watchers.set(agent, dispose)
  }
}
```

**没有 guard、没有 routing 表、没有全局引用计数聚合器。**

---

## 五、三个必须知道的平台事实

写代码时会用到，都经过实测：

### ① `agent/pre-step` 按 agent scope 派发

`dispatch.waterfall` 内部是 `ctx.waterfall(carrier, name, ...)`，`carrier` 就是 agent。所以注册在 `agent.ctx` 上的 `pre-step` 监听器**只对该 agent 触发**，不需要全局节流状态。

### ② `pre-step` 里注册的工具，本次请求看不到

`preStep` 里 `assemble()` 在 `pre-step` 派发**之前**执行，且返回值用旧 `assembly`。所以新工具要**下一条消息**才生效。

验收措辞：**"下一条消息即可用"**，不是"立刻"。

### ③ `register()` 绑在 ctx 上，自动清理

```js
register(definition) {
  return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), ...)
}
```

注册在 `agent.ctx` 上 → agent 销毁时自动注销。**不需要手动管理 disposer。**

---

## 六、实施顺序

### 步骤 1：`locate.js` + 单测
`node --test`，`mkdtemp` 造假目录。验收：5 个场景通过。

### 步骤 2：`transport.js` + `scripts/probe.mjs`
`probe.mjs` 起真实 codegraph，握手，打印工具列表。验收：拿到 `codegraph_explore`；`close()` 后进程消失。

### 步骤 3：`pool.js` + `bridge.js`
扩展 `probe.mjs`：通过 Pool 连接并调用一次。验收：查到真实符号；同项目两次 acquire 只有一个进程。

### 步骤 4：`index.js` + 打包 + 真机验证
装进 desktop profile（Plugins 页粘绝对路径）。验收见下。

---

## 七、验收清单

- [x] 两个不同项目的会话，各自查到正确仓库内容
- [x] 无索引项目的会话里**不存在** `mcp__codegraph__*` 工具
- [x] 同一项目两个会话，只起一个 codegraph 进程
- [x] 会话中途 `codegraph init`，**下一条消息**工具可用
- [x] `disabled: true` 后 codegraph 进程消失
- [x] harness 退出后无残留进程
- [x] 家目录索引不被认领
- [x] 仓库根之上有索引时不被认领
- [x] 工具名冲突时有清晰日志（不静默消失）
- [x] Windows 上能正常启动（`.cmd` 探测生效）

### 实现与本文档的差异

实现完成后回填，方便对照代码与设计：

| 位置 | 文档写法 | 实际实现 | 原因 |
|---|---|---|---|
| `index.js` 取会话目录 | `agent.session?.header?.cwd` | 优先 `ctx.workingDirectory.get(agent.session)`，缺失时退回 `header.cwd` | `header.cwd` 是会话创建时的初始目录，会话中途 `cd` 不更新；用它会在换项目后继续查旧仓库，正是本插件要消灭的问题 |
| `index.js` 挂载时机 | 只在 `agent/created` 挂载，无索引时单独 watch | 统一的会话级 `agent/pre-step` 对齐（比较目标项目根与已挂载项目根），`agent/created` 触发首次对齐 | 同一条逻辑同时覆盖「索引中途出现」「会话中途换项目」「索引被删除」，不需要两套路径 |
| `index.js` 工具 disposer | 注释称不需要手动管理 | 仍保留 `register()` 返回的 disposer | 换项目时必须在同一会话内立即撤销旧工具，否则新旧工具会并存 |
| `bridge.js` `parameters` | 属性 map（`compilePropertyMap`） | 直接透传 MCP `inputSchema` | 实测 `ctx.tools.register()` 走的是原始定义路径，注册表把 `parameters` 原样投影；只有 `defineTool()` 才按属性 map 编译。同版本 `dsh-mcp-client` 也直接透传 `inputSchema` |
| `bridge.js` 任意 JSON 位置 | `{ type: 'json' }` | 空 schema `{}` | DSH 支持的原始 schema 子集没有 `json` 类型，写 `json` 会在注册时抛错 |
| `transport.js` `close()` | 直接 `this.handle.stdin?.end()` | 先 `#settleAll()` 再关 stdin | 让挂起请求立刻失败，而不是等到超时 |
| `pool.js` `connectWithTimeout` | 讨论后放弃 | 未实现，首次连接直接 `await acquire()` | 与文档结论一致；CodeGraph 本地握手实测约 0.6s |

验证入口见 README「验证」一节。

### 关于「暴露 hub.pid」

评审建议给 `ProjectHub` 加 `get pid() { return this.transport?.handle?.pid }`。**没有采用该写法**，因为实测确认 DSH 的 `SubprocessHandle` 不暴露 pid：

```
keys=["stdin","stdout","stderr","control","collected","done","terminate","terminateForHostExit","waitForExit"]
```

那样写会得到一个永远 `undefined` 的字段，比没有更容易误导（`scripts/probe.mjs` 里能拿到 pid 是因为脚本自建了 `node:child_process` 适配器，不是 DSH 的能力）。

替代方案：spawn 时注入 `env: { DSH_CODEGRAPH_PROJECT: projectRoot }`（已验证 `spec.env` 确实传到子进程），并暴露 `ProjectHub.projectTag` / `ProjectHub.stderrTail`。运维和验收脚本按环境变量反查进程即可，与命令行参数形状无关。

### 关于验收脚本的进程判定

原实现用「命令行不含 `--path`」区分插件进程与 CodeGraph 后台 daemon，这是个脆弱假设：`codegraphArgs` 是开放数组，用户加上 `--path` 后断言会假通过。现改为**进程快照差集**（运行前已有 pid 集合 vs 运行后），与参数内容无关，并新增一条 `codegraphArgs` 带 `--path` 的验收用例。

### 关于启动失败的重试

「codegraph 起不来」几乎总是环境问题（未安装、权限、索引损坏），不是瞬时故障。pre-step 每条消息都会重试，因此同一项目上相同的失败原因只告警一次；挂载成功后清空记录，问题复发时会再次告警。

---

## 八、遇到疑问时查什么

| 疑问 | 文档 |
|---|---|
| 为什么这样设计？考虑过哪些替代方案？ | [architecture.md](architecture.md) |
| 这条结论是怎么验证的？有没有源码依据？ | [technical-findings.md](technical-findings.md) |
| 某个边界情况怎么处理？有哪些坑？ | [risks.md](risks.md) |
| 为什么注入 CodeGraph 的 instructions？ | [instructions.md](instructions.md) |

**这些都不需要提前读。** 实现时按本文档写即可。
