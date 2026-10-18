# 技术调研与验证记录

记录开发前的源码调研与实测，供后续开发参考。

调研对象：`C:\deepseek-harness-desktop\resources\app.asar`（DSH `0.2.1-rc.2`）+ CodeGraph `1.6.2`。

---

## 验证 1：agent 作用域工具注册有效（决定性结论）

**早期设计曾假设"agent 作用域注册到不了模型"，该前提已被证伪。**

这一条决定了整个插件架构，所以证据要完整。

### 运行时证据

用子 agent 做对照探测（同一 host 进程、同一全局工具注册表）：

| 工具 | Lead 会话可见 | 子 agent 可见 |
|---|---|---|
| `spawn_teammate` | ✅ | ❌ |
| `wait_agent` | ✅ | ❌ |
| `team_task_*` | ✅ | ❌ |
| 其余 49 个全局工具 | ✅ | ✅ |

子 agent 报告 `TOOL_COUNT: 49`，明确没有 `spawn_teammate`；Lead 会话有它。

**结论：工具可见性确实按会话装配，且能隔离。**

### 源码证据链

**(1) 随发行版交付的 `dsh-experimental-tool-agent-team` 全部工具都通过 `agent.ctx` 注册：**

```js
// dsh-experimental-tool-agent-team/lib/index.js:227-250
function install(agent, ctx, config) {
  const scoped = agent.ctx
  register(scoped.tools.register(defineTool({ name: 'spawn_teammate', ... })))
  ...
}
// :543
ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })
```

**(2) `ToolRuntime.register` 把定义插入当前 ctx 对应的层：**

```js
// dsh-tools ToolRuntime
register(definition) {
  ...
  return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition),
    { label: "tools.register()" })
}
```

**(3) 模型侧装配读的正是这个 scope：**

```js
// dsh-tools ToolRuntime 构造
ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope))

wireSchemas(scope) {
  const view = this.view(scope)
  ...
  return { schemas: [...view.visible.values()].map(...), knownNames: [...] }
}
```

**(4) `view(scope)` 合并 scoped 层，且 own 层无条件可见：**

```js
// dsh-tools ToolRuntime
view(scope) {
  const layers = this.layers.chainLayers(scope)
  const own = this.layers.peek(scope)
  const inherited = new Map(this.layers.global.tools.entries())
  for (const layer of layers) {
    if (layer === own) continue
    for (const [name, definition] of layer.tools.entries()) inherited.set(name, definition)
  }
  const visible = new Map()
  ...
  if (own !== void 0) for (const [name, definition] of own.tools.entries()) {
    visible.set(name, definition)        // ← scoped 层直接可见
  }
  ...
}
```

**(5) scope key 与装配 scope 是同一个对象：**

`agent.ctx` 由 `createScope(loopCtx, agent)` 创建，scope key 就是 agent 对象本身（`dsh-agent-loop`）；装配时传入的 scope 是 `assembleContextFor(agent)` 里的 `{ agent, scope: agent }`（`dsh-agent`）。**两者同一对象，所以 scoped 层必然被合并。**

### 附带发现：`restrict()` 对 scoped 注册无效

```js
// ToolRuntime.restrict 注释
// "Restrictions intersect; scoped registrations remain visible."
```

这解释了早期实现为何绕不过限制——它可能试过 `restrict` 而非 scope 注册。

### 第三方记录的失效说明

`troytse/dsh-plugin-codegraph-project` 在 `agent-tools.js` 里记录"agent 作用域工具永远到不了模型"，那是 **0.1.5-rc.2** 的结论。当前版本 **0.2.1-rc.2** 已不成立。

---

## 验证 2：`pre-step` 装配时序（新发现，影响懒检测措辞）

```js
// dsh-agent-loop preStep
async preStep(target, position) {
  const claimed = this.inbox.claim(target, position.turn)
  const assembly = await this.loopCtx.systemPrompt.assemble(...)   // ← ① 先组装
  signal.throwIfAborted()
  const decision = await this.dispatch.waterfall("agent/pre-step", {  // ← ② 再派发
    messages: claimed, ...position, signal
  }, () => { ... })
  ...
  return { ...decision, assembly }    // ← 用 ① 的 assembly
}
```

**在 `pre-step` 里注册的工具不会进入本次请求**，要等**下一条消息**。

**影响**：懒检测的措辞应为"**下一条消息即可用**"，不是"立刻可用"。这不是缺陷，是装配顺序。

---

## 验证 3：`agent/pre-step` 按 agent scope 派发

```js
// dsh-agent-loop
this.dispatch = agentEvents(loopCtx, this)

// agentEvents
function agentEvents(ctx, agent, carrier = agentCarrier(agent)) {
  return {
    waterfall(name, payload, ...rest) {
      return ctx.waterfall(carrier, name, fused(payload), ...rest)   // ← carrier 是 agent
    },
  }
}
```

**注册在 `agent.ctx` 上的 `pre-step` 监听器只对该 agent 触发**，不需要全局节流状态。

---

## 验证 4：`defineTool` 的 `parameters` 是属性 map

```js
// defineTool
const parameters = parameterSchemaSpecToJsonSchema(options.parameters)

// parameterSchemaSpecToJsonSchema
function parameterSchemaSpecToJsonSchema(spec) {
  const compiled = compilePropertyMap(spec, "parameters")   // ← spec 是属性 map
  return {
    type: "object",
    properties: compiled.properties,
    ...compiled.required === void 0 ? {} : { required: compiled.required },
  }
}
```

**不能直接传完整 JSON Schema**——`type`/`properties`/`required` 会被当成参数名。

**受支持的 schema 子集**（错误信息原文）：

```
subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations
```

`minLength`、`format`、`$comment` 等不支持。`type` 与 `oneOf` 不能同时声明。

---

## 验证 5：`register()` 的必填约束

```js
// ToolRuntime.register
register(definition) {
  const output = definition.output
  if (output === void 0 || typeof output.render !== 'function' || ...) {
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
  }
  const timeoutMs = definition.timeoutMs
  if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`)
  }
  return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), ...)
}
```

**三个要求**：

1. `output` 必须是 `{ schema, render }`
2. `timeoutMs` 若给就必须为正数 → 配置项需 `.min(1)`
3. 返回值是 `layers.effect(this.ctx, ...)`——绑在 ctx 上，agent 销毁时自动注销

---

## 验证 6：CodeGraph 的 tool schema 与 description（实测）

`initialize` + `tools/list` 返回 1 个工具：

```json
{
  "name": "codegraph_explore",
  "description": "PRIMARY TOOL — call FIRST for almost any question OR before an edit: ...",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query":       { "type": "string", "description": "..." },
      "maxFiles":    { "type": "number", "description": "...", "default": 12 },
      "projectPath": { "type": "string", "description": "..." }
    },
    "required": ["query"]
  }
}
```

**关键数据**：

| 项 | 实测值 | 意义 |
|---|---|---|
| 工具数 | 1 | 只需桥接一个 |
| 属性数 | 3，全是标量 | schema 转换器可极简（~20 行） |
| `description` 长度 | **582 字符** | **含核心使用指引**（"PRIMARY TOOL — call FIRST"，"Read-equivalent"） |
| `instructions` 长度 | **6,718 字符** | 进阶用法，本插件不注入（见 why-no-prompt.md） |

`description` 已在提示词里（工具定义的固有部分），这大幅降低了"模型不知道怎么用"的风险。

---

## 验证 7：`ctx.subprocess` API 足够

```js
const handle = subprocess.spawn({
  argv: [program, ...args],
  cwd,
  stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  graceMs,
  env,                    // 增量，服务内部与清洗后的父环境合并
})

handle.stdin / handle.stdout / handle.stderr / handle.pid / handle.done
handle.terminate() / handle.waitForExit()

await subprocess.resolveExecutable(name, env, signal)
```

### 关键陷阱：`resolveExecutable` 会解析到 `.cmd`

```js
// subprocess-local
executableCandidates(command, env) {
  const path = environmentValue(env, "PATH") ?? ""
  const extensions = process.platform === "win32" && extname(command) === ""
    ? (environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""]
  return path.split(delimiter).flatMap(d =>
    extensions.map(e => resolve(process.cwd(), d, command + e)))
}
```

`resolveExecutable('codegraph')` 在 Windows 上**会成功返回 `codegraph.cmd`**（PATHEXT 含 `.CMD`，`access(X_OK)` 也通过）。但 `spawn` 走 Windows Job runner，用 `spawn(command, [...prefix, '--', ...argv])` 且**无 `shell: true` 包装**，所以 `.cmd` 会失败。

`where codegraph` 实测返回两个：

```
%APPDATA%\npm\codegraph       ← POSIX shell 脚本
%APPDATA%\npm\codegraph.cmd   ← Windows 批处理
```

两者都不能直接作为可执行文件 spawn。**需要显式探测与降级**（见 implementation-plan.md 的 resolver）。

---

## 验证 8：`dsh-mcp-client` 的桥接不可复用

- 包只导出 `apply` 和 `Config`；`createTransport`、`buildChildEnv`、工具名规范化都是模块内私有函数
- 接入方式是**声明式**的：通过 `cordis.patch.yml` 插入一行配置
- 没有运行时 API 可以"用某个项目路径创建一个 MCP 连接"

**必须自己写 transport 和 bridge。**

---

## 验证 9：CodeGraph 索引自动同步

探针文件三阶段生命周期（创建 / 修改 / 删除），CLI 与 MCP 两条通道结果一致：

| 阶段 | CLI | MCP | daemon 日志 |
|---|---|---|---|
| 创建 | 查到新符号 | — | `Auto-synced 1 file in 2858ms` |
| 修改 | 新签名正确，旧名消失 | 返回最新源码 | `Auto-synced 1 file in 1603ms` |
| 删除 | 查不到 | 只剩无关匹配 | `Auto-synced 1 file in 3ms` |

**延迟 3–6 秒**。插件**不需要**自己触发 `codegraph sync`。

---

## 验证 10：CodeGraph 多项目共存

- daemon 注册表按项目路径 hash 出独立命名管道：`~/.codegraph/daemons/<hash>.json` 含 `root` 字段
- 多个项目同时有 daemon 是正常状态，物理隔离
- 单个 MCP 进程也能通过 `projectPath` 参数服务多个项目

本插件仍选择一项目一进程（见 architecture.md 决策 2）。

---

## 验证 11：CodeGraph 关闭时 stdin EOF 优先

实测 stdin 关闭后 CodeGraph 在**几毫秒内**退出。

因此 `close()` 顺序是 `stdin.end()` → 等待 → `terminate()` 兜底。

---

## 验证 12：MCP 握手响应

```
codegraph.exe lib\dist\bin\codegraph.js serve --mcp
```

返回：

```json
{
  "protocolVersion": "2024-11-05",
  "capabilities": { "tools": {} },
  "serverInfo": { "name": "codegraph", "version": "1.6.2" }
}
```

---

## 待开发时复核

- [ ] `agent.session.header.cwd` 在程序化驱动（SDK / headless / ACP）会话中是否可用
- [ ] `working_directory` 工具切换目录时，`header.cwd` 是否变化（若变化，挂载的项目需要重新校验）
- [ ] npm 布局探测（`.cmd` → `node.exe` + `codegraph.js`）在你的环境下是否成立
