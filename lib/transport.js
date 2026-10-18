/**
 * MCP stdio transport，跑在 `ctx.subprocess` 上。
 *
 * 为什么不用 MCP SDK 的 StdioClientTransport：它内部用 node:child_process spawn，
 * 进程不受 DSH 管理，插件 disabled 或 harness 退出后会残留。
 *
 * 只实现本项目用到的 MCP 子集：initialize 握手、tools/list、tools/call。
 * 帧格式是 NDJSON（每行一个 JSON-RPC 消息），与 CodeGraph 1.6.2 实测一致。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 与 CodeGraph 1.6.2 实测一致的协议版本。 */
const PROTOCOL_VERSION = '2024-11-05'
/** stderr 只留尾部：诊断用途，不参与协议。 */
const STDERR_TAIL_BYTES = 8 * 1024
/** 主动终止时先给 SIGTERM，再等这个宽限后 SIGKILL；由 ctx.subprocess 的 graceMs 落实。 */
const TERMINATE_GRACE_MS = 3000

/**
 * 注入子进程的项目标识环境变量。
 *
 * DSH 的 `SubprocessHandle` 不暴露 pid（实测接口只有 stdin/stdout/stderr/control/
 * collected/done/terminate/waitForExit），所以无法从 handle 读出「这个项目对应哪个
 * OS 进程」。环境变量是可靠的替代：运维和验收脚本都能从进程环境变量反查项目根，
 * 也能据此把日志行和进程对应起来。
 */
export const PROJECT_ENV = 'DSH_CODEGRAPH_PROJECT'

/**
 * 解析真正的启动 argv。
 *
 * Windows 上 `codegraph` 是 npm 的 `.cmd` 批处理，不能直接 spawn；而
 * `subprocess.resolveExecutable('codegraph')` 会因为 PATHEXT 含 `.CMD` 成功返回
 * `.cmd` 路径，把错误推迟到 spawn 阶段。所以这里显式处理 `.cmd` 布局。
 *
 * @param {object} subprocess ctx.subprocess
 * @param {{ codegraphBin: string, codegraphArgs: string[] }} config
 * @param {AbortSignal} [signal]
 * @returns {Promise<string[]>} 完整 argv，argv[0] 是可执行文件绝对路径。
 */
export async function resolveArgv(subprocess, config, signal) {
  // 用户配置优先：显式给出可执行文件时不再猜测。
  if (config.codegraphBin) return [config.codegraphBin, ...config.codegraphArgs]

  let resolved
  try {
    resolved = await subprocess.resolveExecutable('codegraph', undefined, signal)
  } catch (error) {
    throw new Error(
      `codegraph not found on PATH. Install it (npm i -g @colbymchenry/codegraph) ` +
        `or set codegraphBin in this plugin's row config. Cause: ${error?.message ?? String(error)}`,
    )
  }

  // .exe 等原生可执行文件可以直接 spawn。
  if (!/\.(cmd|bat)$/i.test(resolved)) return [resolved, ...config.codegraphArgs]

  // `.cmd` → 从 npm 全局布局推导 node.exe + 入口脚本。
  // 这一步依赖 npm 的全局安装目录结构，是已知的脆弱点；失败时给出可复制配置。
  const npmPrefix = dirname(resolved) // .../npm
  const packageRoot = join(npmPrefix, 'node_modules', '@colbymchenry', 'codegraph')
  const platformPackage = join(
    packageRoot,
    'node_modules',
    '@colbymchenry',
    `codegraph-${process.platform}-${process.arch}`,
  )
  const nodeExe = join(platformPackage, 'node.exe')
  const entry = join(platformPackage, 'lib', 'dist', 'bin', 'codegraph.js')
  if (existsSync(nodeExe) && existsSync(entry)) return [nodeExe, entry, ...config.codegraphArgs]

  throw new Error(
    [
      `cannot launch codegraph: ${resolved} is a .cmd shim and cannot be spawned directly.`,
      `Tried the npm layout at ${platformPackage} but did not find node.exe + lib/dist/bin/codegraph.js.`,
      `Set codegraphBin on this plugin's row config to the codegraph executable, for example:`,
      `  config:`,
      `    codegraphBin: ${nodeExe}`,
      `    codegraphArgs: [${entry}, serve, --mcp]`,
    ].join('\n'),
  )
}

/**
 * 一个受 DSH 管理的 MCP stdio 连接。
 *
 * 生命周期：`start()` 拉起子进程并完成握手，`close()` 先关 stdin 等自然退出，
 * 再走 terminate 兜底。CodeGraph 在 stdin EOF 后几毫秒内退出，所以 stdin-first
 * 是主路径。
 */
export class ManagedStdioTransport {
  /**
   * @param {object} options
   * @param {object} options.subprocess ctx.subprocess
   * @param {string[]} options.argv 完整 argv
   * @param {string} options.cwd 项目根：CodeGraph 以进程 cwd 作为默认项目
   * @param {string} options.label 日志与错误信息里的项目标识
   * @param {number} options.connectTimeoutMs 握手超时
   */
  constructor({ subprocess, argv, cwd, label, connectTimeoutMs }) {
    this.subprocess = subprocess
    this.argv = argv
    this.cwd = cwd
    this.label = label
    this.connectTimeoutMs = connectTimeoutMs

    this.handle = undefined
    this.closed = false
    this.closePromise = undefined
    this.exitPromise = undefined
    this.stderrTail = ''
    this.nextId = 1
    /** 请求 id → { resolve, reject, timer } */
    this.pending = new Map()
    /** stdout 行缓冲：一帧 JSON 可能跨 chunk。 */
    this.lineBuffer = ''

    this.onerror = undefined
    this.onclose = undefined
    /** @type {Map<string, { name: string, description: string, inputSchema: object }>} */
    this.tools = new Map()
    this.capabilities = undefined
    this.serverInfo = undefined
  }

  get running() {
    return this.handle !== undefined && !this.closed
  }

  /** 拉起子进程；同步返回 handle，进程就绪与否由 done 决定。 */
  launch() {
    this.handle = this.subprocess.spawn({
      argv: this.argv,
      cwd: this.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: TERMINATE_GRACE_MS,
      // 给子进程打上项目标识：DSH 的 SubprocessHandle 不暴露 pid，这是把日志行、
      // 诊断脚本和 OS 进程对应起来的唯一稳定手段（可从进程环境变量反查）。
      env: { [PROJECT_ENV]: this.cwd },
    })
    this.exitPromise = this.handle.done.catch(() => ({ exitCode: null, signal: null }))

    this.handle.stderr?.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
    })
    this.handle.stdout?.on('data', (chunk) => this.#consume(chunk.toString('utf8')))
    this.handle.stdout?.on('end', () => this.#settleAll(new Error('codegraph closed stdout')))
    // 子进程自己退出（崩溃、另一处的 terminate）时，让挂起请求失败而不是永远等。
    this.handle.done.then(
      () => this.#settleAll(new Error(`codegraph exited: ${this.describeExit()}`)),
      (error) => this.#settleAll(error),
    )
    return this.handle
  }

  /** 启动并完成 MCP 握手，随后拉取工具列表。 */
  async start() {
    this.launch()
    const initialize = await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-codegraph-project', version: '0.0.1' },
      },
      this.connectTimeoutMs,
    )
    this.capabilities = initialize.capabilities
    this.serverInfo = initialize.serverInfo
    this.notify('notifications/initialized')

    const list = await this.request('tools/list', {}, this.connectTimeoutMs)
    for (const tool of list.tools ?? []) {
      this.tools.set(tool.name, {
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      })
    }
    return { serverInfo: this.serverInfo, tools: [...this.tools.values()] }
  }

  /** 发送一条请求并等待对应响应。 */
  request(method, params, timeoutMs) {
    if (this.closed) return Promise.reject(new Error(`codegraph transport for ${this.label} is closed`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms. ${this.diagnostics()}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** 发送一条通知（无 id，无响应）。 */
  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** 写入一行 NDJSON。 */
  send(message) {
    const stdin = this.handle?.stdin
    if (stdin === undefined) throw new Error(`codegraph transport for ${this.label} has no stdin`)
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  /**
   * 关闭连接：先关 stdin 让 CodeGraph 自行退出，超时才 terminate。
   *
   * 高层的 `codegraph serve --mcp` 在 stdin EOF 后立即退出，所以我们不去打扰它；
   * 只有卡住时才升级为信号。
   */
  async close() {
    if (this.closePromise !== undefined) return this.closePromise
    this.closed = true
    this.closePromise = (async () => {
      this.#settleAll(new Error(`codegraph transport for ${this.label} closed`))
      try {
        this.handle?.stdin?.end()
      } catch {
        // stdin 可能已经因为进程退出而关闭，忽略。
      }
      if (await this.waitForExit({ timeoutMs: TERMINATE_GRACE_MS + 2000 })) return
      try {
        this.handle?.terminate()
      } catch {
        // terminate 只可能在 handle 已释放时失败。
      }
      await this.waitForExit({ timeoutMs: TERMINATE_GRACE_MS + 5000 })
    })()
    return this.closePromise
  }

  /** 等待进程退出；`true` 表示已退出，`false` 表示超时。 */
  async waitForExit({ timeoutMs }) {
    if (this.exitPromise === undefined) return true
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    try {
      return await Promise.race([this.exitPromise.then(() => true), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /** 一行人类可读的进程结局，用于错误信息。 */
  describeExit() {
    const exitCode = this.handle?.exitCode
    return exitCode === undefined ? 'unknown exit' : `exit ${exitCode}`
  }

  /** 综合诊断：进程结局 + stderr 尾部。握手失败时这是唯一有效线索。 */
  diagnostics() {
    const stderr = this.stderrTail.trim()
    return stderr === '' ? `(${this.describeExit()}, no stderr)` : `${this.describeExit()}, stderr: ${stderr}`
  }

  /** 按行切分 stdout；跨 chunk 的半行留在缓冲里。 */
  #consume(text) {
    this.lineBuffer += text
    let index
    while ((index = this.lineBuffer.indexOf('\n')) >= 0) {
      const line = this.lineBuffer.slice(0, index).trim()
      this.lineBuffer = this.lineBuffer.slice(index + 1)
      if (line !== '') this.#dispatch(line)
    }
  }

  #dispatch(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      // CodeGraph 承诺纯 NDJSON；解析失败说明对端输出了非协议内容，报告但不中断流。
      this.onerror?.(new Error(`codegraph for ${this.label} wrote a non-JSON stdout line: ${line.slice(0, 200)}`))
      return
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const settled = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(settled.timer)
      if (message.error !== undefined) settled.reject(new Error(`${message.error.message ?? 'MCP error'}`))
      else settled.resolve(message.result)
      return
    }

    // 服务端主动通知（如 notifications/tools/list_changed）暂不消费，忽略即可。
    if (message.method !== undefined && message.id === undefined) return
    this.onclose?.(message)
  }

  /** 让所有挂起请求以同一个原因失败，避免会话阻塞在无望的等待上。 */
  #settleAll(error) {
    for (const [id, settled] of this.pending) {
      clearTimeout(settled.timer)
      settled.reject(error)
      this.pending.delete(id)
    }
  }
}
