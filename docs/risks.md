# 风险与边界条件

## 高风险

### R1：Windows `.cmd` 无法直接 spawn（最可能踩的坑）

**场景**：`codegraph` 在 Windows 上是 npm 生成的 `.cmd` 批处理脚本。

**证据**（`subprocess-local`）：

```js
executableCandidates(command, env) {
  const extensions = process.platform === "win32" && extname(command) === ""
    ? (environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""]
  ...
}
```

`resolveExecutable('codegraph')` **会成功返回 `codegraph.cmd`**（解析不报错），但 `spawn` 走 Windows Job runner，用 `spawn(command, ...)` 且无 `shell: true`，`.cmd` 无法执行。

**后果**：错误发生在 spawn 阶段，表现为不明确的启动失败。

**应对**：三层探测降级

```
1. 用户配了 codegraphBin → 直接用
2. resolveExecutable → .exe 直接用；.cmd/.bat 进入 3
3. 从 .cmd 所在目录推导 npm 布局，找到 node.exe + codegraph.js
4. 都失败 → 抛错，错误信息含：探测到的路径、原因、可直接复制的配置示例
```

**风险点**：第 3 步依赖 npm 目录布局（`<prefix>/node_modules/@colbymchenry/codegraph/node_modules/@colbymchenry/codegraph-<platform>/`）。布局变化时降级到第 4 步。

**验收**：必须验证在你的环境下能启动成功，或给出清晰错误。

### R2：工具名冲突

**场景**：同时装了 `dsh-mcp-client` 的 codegraph 行，又装本插件。两者都用 `serverName: codegraph`。

**后果**：`register()` 抛错。若代码 `catch` 但不记录，工具会静默消失。

**应对**：

- 捕获注册错误并打清晰日志，说明是命名空间冲突、怎么改
- 文档写明：装插件前先删掉 profile 里原有的 codegraph MCP 行

**验收**：冲突时日志可读，不是静默。

### R3：`agent.session.header.cwd` 可能缺失

**场景**：程序化驱动（SDK、headless、ACP）的会话可能不设 `header.cwd`。

**后果**：无法定位项目。

**应对**：`locate.js` 返回 `no-cwd`，注册 `pre-step` 懒检测（万一后续 cwd 出现），不崩溃。

**待验证**：开发时确认各驱动形态下 `header.cwd` 的可用性。

### R4：子进程泄漏

**场景**：用了 `node:child_process` 而非 `ctx.subprocess`，或关闭逻辑遗漏。

**后果**：CodeGraph 进程残留，占用内存、持有 SQLite 连接、持续监听文件。

**应对**：

- **强制**走 `ctx.subprocess.spawn`
- `close()` 幂等，并发调用共享同一个 Promise
- 插件卸载时 `pool.closeAll()`

**验收**：`disabled: true` 后进程消失；harness 退出后无残留。

## 中风险

### R5：懒检测的时序预期

**场景**：用户在会话中途执行 `codegraph init`，期望"立刻可用"。

**实际**：`preStep` 里 `assemble()` 在 `pre-step` 派发**之前**（`app.asar:319835` vs `319837`），所以在 `pre-step` 里注册的工具**不进入本次请求**。

**后果**：模型需要**下一条消息**才能看到工具。

**应对**：文档与验收措辞统一为"下一条消息即可用"。这不是缺陷，是 DSH 装配顺序。

### R6：`pre-step` 懒检测的 stat 开销

**场景**：未索引会话每 step 都执行 `locateIndex`（两次 stat）。

**后果**：正常情况下可忽略（本地磁盘 stat 是微秒级）。但若同时开着多个未索引会话，会有累积。

**应对**：

- 挂载成功后立即注销监听
- 配置项 `watchIntervalMs`（默认 2000ms）做节流
- 上限：每会话每秒最多 0.5 次 stat

### R7：路径大小写与符号链接

**场景**：Windows 路径大小写不敏感；macOS 上 `/tmp` 是 `/private/tmp` 的符号链接。

**后果**：项目根比较失败，同一项目被当成两个（起两个进程），或家目录保护被绕过。

**应对**：

- 缓存键统一 `path.resolve()` 规范化
- 家目录比较优先 `realpathSync`（失败退回 `resolve`）
- Windows 上比较前统一大小写

### R8：`.codegraph` 无权限读取

**场景**：`.codegraph/` 存在但 `readdir` 失败（EACCES、EIO、断链符号链接）。

**后果**：若继续向上查找，会认领祖先项目的索引——变成"服务了错误的代码库"。

**应对**：**停止向上**，返回 `index-unreadable` 并记录 `indexRoot` 与错误原因。

### R9：家目录索引被误认领

**场景**：用户曾执行 `codegraph init --force -- ~`，产生 `~/.codegraph/codegraph.db`。而 `~/.codegraph` 同时也是 CodeGraph CLI 的运行时目录。

**后果**：`$HOME` 下**所有**会话都认领同一个索引。

**应对**：

- 找到含 db 的 `.codegraph/` 后，检查该目录是否为家目录或文件系统根
- 命中则拒绝
- 嵌套在家目录里的真实项目（`~/work/api`）不受影响

### R10：MCP 协议版本演进

**场景**：CodeGraph 升级后调整 `initialize` 协议版本、返回结构，或新增/改名工具。

**应对**：

- 工具列表**完全动态获取**，不硬编码 `codegraph_explore`
- schema 转换遇到未知类型降级为 `json`，不抛错
- 不断言 `protocolVersion`

## 低风险

### R11：工具调用超时

CodeGraph 在大仓库首次查询可能较慢。默认 60 秒。

**注意**：`register()` 会校验 `timeoutMs > 0`，配置项必须有 `.min(1)`，否则抛 `TypeError`。

### R12：项目很多时的进程数

每个有索引的项目一个常驻进程。同时开 10 个项目的会话 = 10 个进程。

**应对**：A 路线的固有代价。若实际有问题，可加"空闲项目超时关闭"，首版不做。

### R13：会话中切换工作目录

**场景**：DSH 支持 `working_directory` 工具切换目录。

**后果**：`agent/created` 时挂载的项目会过期。

**应对**：**首版不处理**。开发时先确认 `working_directory` 是否真的改变 `header.cwd`；若会，后续可在 `pre-step` 里做一次比对（成本很低，因为懒检测监听器只对未索引会话存在——需要扩展为所有会话）。

## 明确不做的

| 不做 | 理由 |
|---|---|
| 自动 `codegraph init` | 建索引是用户的决定，CodeGraph 官方也坚持这点 |
| CodeGraph 版本管理 | 用户自己装、自己升级 |
| 遥测开关 | 不干预 CodeGraph 默认行为 |
| 注入 instructions | 见 why-no-prompt.md |
| 诊断 UI / 设置页 | 日志足够；显著扩大维护面 |
| 断线重连（首版） | 先验证基础可用性 |
| 索引轮询定时器 | 用 `agent/pre-step` 懒检测替代 |
| 移除 `projectPath` 参数 | 它是原生能力，见 architecture.md 决策 7 |

## 验收时必须验证的风险项

- [ ] R1 能正常启动，或给出可操作的错误
- [ ] R2 工具名冲突时有清晰日志（不静默）
- [ ] R3 无 cwd 的会话不崩溃
- [ ] R4 `disabled: true` 后进程消失；harness 退出后无残留
- [ ] R5 中途建索引后"下一条消息"可用
- [ ] R8 不可读的 `.codegraph` 不向上认领
- [ ] R9 家目录索引被拒绝，但嵌套项目正常
