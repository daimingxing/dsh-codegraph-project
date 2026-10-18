/**
 * 按项目根聚合的 CodeGraph 连接池。
 *
 * 一个项目根对应一个 CodeGraph 子进程：进程 cwd 就是项目根，查询不需要额外
 * 参数。多个会话命中同一项目时共享该进程，用引用计数决定何时关闭。
 *
 * 首版不做断线重连：进程意外退出时，后续调用直接报错，由调用方/用户重新开始
 * 会话。这比半途悄悄重启更可预期，也避免会话拿着已失效的引用继续查。
 */

import { ManagedStdioTransport, resolveArgv } from './transport.js'

/**
 * 一个项目的 MCP 连接。
 *
 * 连接是幂等的：`connect()` 并发调用共享同一个 promise；失败后允许重试。
 * `retain()`/`release()` 只计引用，不隐藏连接状态。
 */
export class ProjectHub {
  /**
   * @param {object} options
   * @param {string} options.projectRoot 项目根（含 `.codegraph/`）
   * @param {object} options.deps 共享依赖：`subprocess` 与解析好的配置
   * @param {(message: string) => void} [options.warn] 诊断日志出口
   */
  constructor({ projectRoot, deps, warn }) {
    this.projectRoot = projectRoot
    this.deps = deps
    this.warn = warn ?? (() => {})
    this.refs = 0
    /** 已开始的连接；成功后保留，失败后清空以允许重试。 */
    this.connecting = undefined
    this.transport = undefined
    this.closed = false
  }

  /** 当前引用计数；仅用于测试与诊断。 */
  get references() {
    return this.refs
  }

  /** 已连接且未关闭。 */
  get connected() {
    return this.transport !== undefined && !this.closed
  }

  /**
   * 该连接对应子进程的项目标识，用于把日志行、诊断脚本和 OS 进程对应起来。
   *
   * 不是 pid：DSH 的 SubprocessHandle 不暴露 pid（实测确认）。子进程的环境变量里
   * 带有同一个值，因此排查时可以从进程环境反查项目，或用它区分插件进程与
   * CodeGraph 自己的后台 daemon。未连接时为 `undefined`。
   */
  get projectTag() {
    return this.connected ? this.projectRoot : undefined
  }

  /** 子进程 stderr 结尾，握手或调用失败时用于诊断；未连接时为空串。 */
  get stderrTail() {
    return this.transport?.stderrTail ?? ''
  }

  /** 工具列表：连接前为空。 */
  tools() {
    return this.transport === undefined ? [] : [...this.transport.tools.values()]
  }

  retain() {
    this.refs += 1
    return this
  }

  /** 减少引用；归零时关闭连接。返回是否已关闭。 */
  async release() {
    this.refs = Math.max(0, this.refs - 1)
    if (this.refs > 0) return false
    await this.close()
    return true
  }

  /** 建立连接，幂等且并发共享。失败时清空连接状态以便下一次重试。 */
  async connect() {
    if (this.closed) throw new Error(`codegraph hub for ${this.projectRoot} is closed`)
    if (this.transport !== undefined) return this
    this.connecting ??= this.#doConnect().finally(() => {
      this.connecting = undefined
    })
    return this.connecting
  }

  async #doConnect() {
    const { subprocess, config } = this.deps
    const argv = await resolveArgv(subprocess, config)
    const transport = new ManagedStdioTransport({
      subprocess,
      argv,
      // 进程 cwd 决定 CodeGraph 的默认项目，这是整个插件的核心机制。
      cwd: this.projectRoot,
      label: this.projectRoot,
      connectTimeoutMs: config.connectTimeoutMs,
    })
    transport.onerror = (error) => this.warn(`codegraph(${this.projectRoot}): ${error.message}`)
    try {
      await transport.start()
    } catch (error) {
      // 失败时也要收拾子进程，否则第二次重试前面已经留下一个孤儿。
      await transport.close().catch(() => {})
      throw new Error(`cannot start codegraph for ${this.projectRoot}: ${error.message}`)
    }
    if (this.closed) {
      await transport.close().catch(() => {})
      throw new Error(`codegraph hub for ${this.projectRoot} was closed during connect`)
    }
    this.transport = transport
    return this
  }

  /**
   * 调一次 MCP 工具。
   * @param {string} rawName MCP 原始工具名（如 codegraph_explore）
   * @param {object} args 参数
   * @param {{ signal?: AbortSignal }} [exec] 工具执行上下文
   */
  async call(rawName, args, exec) {
    const transport = this.transport
    if (transport === undefined || this.closed) {
      throw new Error(`codegraph for ${this.projectRoot} is not connected`)
    }
    const result = await transport.request(
      'tools/call',
      { name: rawName, arguments: args ?? {} },
      this.deps.config.toolCallTimeoutMs,
    )
    // MCP 用 isError 标记工具级失败；宿主工具抛错即可，渲染层会统一呈现。
    if (result?.isError === true) {
      throw new Error(textOf(result.content) || `codegraph tool "${rawName}" failed`)
    }
    return result
  }

  /** 关闭连接；幂等。 */
  async close() {
    if (this.closed) return
    this.closed = true
    const transport = this.transport
    this.transport = undefined
    if (transport !== undefined) await transport.close().catch(() => {})
  }
}

/** 拼接 MCP content 里的文本块，用于错误信息。 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n')
    .trim()
}

/**
 * 项目连接池。
 *
 * 引用计数由调用方（会话）持有：会话销毁时 release，归零才关进程。因此同一项目
 * 的两个会话共享一个子进程，最后一个会话离开时才回收。
 */
export class Pool {
  /** @param {object} deps 传给 ProjectHub 的共享依赖 */
  constructor(deps) {
    this.deps = deps
    /** @type {Map<string, ProjectHub>} */
    this.hubs = new Map()
  }

  /**
   * 加引用并连接。
   *
   * 必须先 retain 再 await：连接期间的会话销毁会 release 掉自己那份引用，
   * 如果等连接成功后才 retain，就会把别人正在用的引用减掉。
   *
   * @param {string} projectRoot
   * @returns {Promise<ProjectHub>}
   */
  async acquire(projectRoot) {
    const existing = this.hubs.get(projectRoot)
    if (existing !== undefined) {
      if (existing.closed) {
        // 上一个引用批次已关闭：换一个新的 hub，不能复用已关闭的连接。
        this.hubs.delete(projectRoot)
      } else {
        existing.retain()
        try {
          return await existing.connect()
        } catch (error) {
          await existing.release().catch(() => {})
          throw error
        }
      }
    }

    const hub = new ProjectHub({ projectRoot, deps: this.deps, warn: this.deps.warn })
    this.hubs.set(projectRoot, hub)
    hub.retain()
    try {
      return await hub.connect()
    } catch (error) {
      hub.refs = 0
      await hub.close().catch(() => {})
      if (this.hubs.get(projectRoot) === hub) this.hubs.delete(projectRoot)
      throw error
    }
  }

  /**
   * 减引用；归零则关闭并从池中移除。
   *
   * @returns {Promise<{ remaining: number, closed: boolean } | undefined>}
   *   该项目的剩余引用数与是否已关闭进程；项目不在池中时返回 `undefined`。
   *   调用方（会话销毁路径）用它写诊断日志。
   */
  async release(projectRoot) {
    const hub = this.hubs.get(projectRoot)
    if (hub === undefined) return undefined
    const closed = await hub.release()
    const remaining = hub.references
    if (closed && this.hubs.get(projectRoot) === hub) this.hubs.delete(projectRoot)
    return { remaining, closed }
  }

  /** 已连接的项目 hub（不会触发连接）。 */
  get(projectRoot) {
    const hub = this.hubs.get(projectRoot)
    return hub === undefined || hub.closed ? undefined : hub
  }

  /** 池中全部 hub，含正在连接的。 */
  list() {
    return [...this.hubs.values()]
  }

  /** 关闭全部连接；用于插件卸载。 */
  async closeAll() {
    const hubs = [...this.hubs.values()]
    this.hubs.clear()
    await Promise.allSettled(hubs.map((hub) => hub.close()))
  }
}
