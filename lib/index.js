/**
 * dsh-codegraph-project：把用户已安装的 CodeGraph 按项目维度接入 DSH。
 *
 * 问题：CodeGraph 的 MCP 服务只能从自身进程 cwd 推断「当前项目」，而 DSH 插件
 * 配置是 profile 级（全局），写死一个 cwd 后换项目就会静默查询错误的仓库。
 *
 * 解法：读会话工作目录 → 定位 `.codegraph/` 索引 → 每个项目一个 CodeGraph 子进程
 * → 工具注册到该会话的 scope。三条关键机制：
 *
 * 1. 工具注册在 `agent.ctx` 上。模型工具列表按会话 scope 组装，所以无索引会话根本
 *    看不到工具，不需要运行时拒绝。
 * 2. 每个项目一个子进程，进程 cwd 就是项目根，查询不需要额外参数。
 * 3. 子进程走 `ctx.subprocess`，由 DSH 托管，disabled 或退出时不会残留。
 *
 * 挂载与卸载只由一个会话级 pre-step 监听器驱动：它在每条消息前比较「当前目录对应的
 * 项目根」与「已挂载的项目根」，覆盖三种变化——索引在会话中途出现、用户 cd 到另一个
 * 项目、以及索引被删除。这样没有 routing 表，也不会出现工具指向旧仓库的情况。
 */

import { Config as RowConfig } from './config.js'
import { createBridgedTool } from './bridge.js'
import { locateIndex } from './locate.js'
import { Pool } from './pool.js'

export const name = 'codegraph-project'
export const inject = ['subprocess', 'tools']
export const Config = RowConfig

/**
 * 会话当前工作目录。
 *
 * 用 `workingDirectory` 服务而不是 `session.header.cwd`：后者只是会话创建时的初始
 * 目录，用户中途 `cd` 到别的项目后它不会变，按它定位会继续查询旧仓库。该服务由
 * `dsh-base` 挂载，是所有 profile 的公共依赖，因此按可选依赖读取，缺失时退回 header。
 */
function sessionDirectory(ctx, agent) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory !== undefined) {
    try {
      return workingDirectory.get(agent.session)
    } catch {
      // 服务存在但读不到状态（例如会话尚未投影）：退回 header。
    }
  }
  return agent.session?.header?.cwd
}

export function apply(ctx, config) {
  if (!config.enabled) return

  const logger = ctx.logger(name)
  const pool = new Pool({
    subprocess: ctx.subprocess,
    config,
    warn: (message) => logger.warn(message),
  })

  /**
   * agent → 已挂载状态。
   *
   * `projectRoot` 与 `disposers` 一起构成可回退的挂载点：换项目或索引消失时按顺序
   * 卸载工具并释放引用，再决定是否挂载新项目。
   * @type {WeakMap<object, { projectRoot: string, disposers: Array<() => void>, tools: string[] }>}
   */
  const mounts = new WeakMap()
  /** agent → 上次探测时间，用于按 watchIntervalMs 节流。 */
  const lastChecks = new WeakMap()
  /**
   * agent → 已上报过的启动失败原因。
   *
   * 同一条项目上「codegraph 起不来」通常不是瞬时的（可执行文件缺失、权限、索引损坏），
   * 而 pre-step 每条消息都会重试。记录最后一次失败的错误文本，只在成败发生变化时
   * 写日志，避免每个 step 刷一条同样的告警。
   */
  const failedChecks = new WeakMap()

  ctx.on('agent/created', ({ agent, signal }) => {
    // agent/created 是串行的：先挂好，模型的第一条消息就能拿到工具。
    return reconcile(agent, { force: true, signal }).catch((error) => {
      logger.warn(`codegraph mount failed at session start: ${error.message}`)
    })
  })

  ctx.on('agent/disposed', async ({ agent }) => {
    const mount = mounts.get(agent)
    mounts.delete(agent)
    lastChecks.delete(agent)
    failedChecks.delete(agent)
    if (mount === undefined) return
    unmount(mount)
    const released = await pool
      .release(mount.projectRoot)
      .catch((error) => {
        logger.warn(`codegraph release failed for ${mount.projectRoot}: ${error.message}`)
        return undefined
      })
    if (released === undefined) return
    // 释放路径只走 debug：正常会话结束会频繁触发，info 级会淹没真正的问题；
    // 但泄漏排查时需要它，所以不能完全静默。
    logger.debug(
      released.closed
        ? `released codegraph for ${mount.projectRoot} (last session, process closed)`
        : `released codegraph for ${mount.projectRoot} (${released.remaining} session(s) left)`,
    )
  })

  /**
   * 每条消息前重新对齐。注册在 `agent.ctx` 之外的顶层 ctx 上也能工作，但这里用
   * `agent.ctx`：作用域监听器只对该 agent 触发，天然不需要按 agent 区分状态。
   *
   * 注意：pre-step 里挂载的工具本次请求看不到，要下一条消息才生效。
   */
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.on('agent/pre-step', async (payload, next) => {
      await reconcile(agent).catch((error) => {
        logger.warn(`codegraph re-check failed: ${error.message}`)
      })
      return next()
    })
  })

  // 插件卸载：关掉所有子进程。
  ctx.effect(() => () => pool.closeAll())

  /**
   * 把会话的挂载状态对齐到当前目录。
   *
   * - 目录未变：什么都不做（绝大多数消息走这条）。
   * - 目录变了且新目录有索引：换项目。
   * - 目录变了且新目录无索引：卸载，之后继续懒检测。
   *
   * 失败不抛出：pre-step 的调用方只需要拿到决策后继续本轮，不能因为 codegraph
   * 起不来而中断用户的消息。失败原因记进 `failedChecks`，只在首次出现和
   * 恢复后再次出现时写日志。
   */
  async function reconcile(agent, { force = false, signal } = {}) {
    const now = Date.now()
    // 会话创建的首次对齐必须做，之后按配置节流。
    if (!force) {
      const previous = lastChecks.get(agent) ?? 0
      if (now - previous < config.watchIntervalMs) return
    }
    lastChecks.set(agent, now)

    const cwd = sessionDirectory(ctx, agent)
    const location = locateIndex(cwd)
    const targetRoot = location.state === 'indexed' ? location.projectRoot : undefined
    const current = mounts.get(agent)

    if (current !== undefined && current.projectRoot === targetRoot) {
      // 已经挂对了：清掉失败记录，下次真的失败时会重新告警。
      failedChecks.delete(agent)
      return
    }

    // 先卸载：这一步同步撤销工具注册，避免新旧工具同时可见。
    if (current !== undefined) {
      unmount(current)
      mounts.delete(agent)
      await pool.release(current.projectRoot).catch((error) => {
        logger.warn(`codegraph release failed for ${current.projectRoot}: ${error.message}`)
      })
    }

    if (targetRoot === undefined) {
      failedChecks.delete(agent)
      return
    }

    // 同项目已有连接：直接挂到既有 hub，不重复启动进程。
    const existing = pool.get(targetRoot)
    let hub = existing
    if (hub === undefined) {
      try {
        hub = await pool.acquire(targetRoot)
      } catch (error) {
        reportFailure(agent, targetRoot, error)
        return
      }
    }
    // acquire 期间会话可能已销毁；signal 已中止时立刻还回引用，别留下悬挂子进程。
    if (signal?.aborted === true) {
      await pool.release(targetRoot).catch(() => {})
      return
    }
    failedChecks.delete(agent)
    mount(agent, hub, targetRoot)
  }

  /**
   * 记录并上报一次启动失败。
   *
   * 「codegraph 无法启动」几乎总是环境问题，而 pre-step 每条消息都会重试；因此同一
   * 项目上相同的失败原因只报一次，重复重试不再刷屏。恢复后（挂载成功）会清空记录，
   * 所以同一个问题复发时仍会再报。
   */
  function reportFailure(agent, projectRoot, error) {
    const reason = error?.message ?? String(error)
    if (failedChecks.get(agent) === reason) return
    failedChecks.set(agent, reason)
    // 失败的 hub 已被 Pool 清理，所以剩余引用数恒为 0；提示用户检查环境而不是重试。
    logger.warn(
      `codegraph unavailable for ${projectRoot}: ${reason}. ` +
        `Will keep retrying on later messages; check that codegraph is installed and the index is readable.`,
    )
  }

  /**
   * 把 hub 的工具注册到该会话 scope。
   *
   * 注册在 `agent.ctx` 上，agent 销毁时 DSH 会自动撤销；这里仍保留 disposer，用于
   * 换项目时立即撤销，避免新旧工具在同一个会话里并存。
   */
  function mount(agent, hub, projectRoot) {
    const disposers = []
    const names = []
    for (const tool of hub.tools()) {
      const publicName = `mcp__${config.serverName}__${tool.name}`
      try {
        disposers.push(
          agent.ctx.tools.register(
            createBridgedTool({
              publicName,
              rawName: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              hub,
              timeoutMs: config.toolCallTimeoutMs,
            }),
          ),
        )
        names.push(publicName)
      } catch (error) {
        // 冲突必须可见：静默消失会让人以为工具坏了。
        logger.error(
          `could not register ${publicName}: ${error.message}. ` +
            `This usually means another MCP server owns the "${config.serverName}" namespace. ` +
            `Set a distinct serverName on the codegraph-project row.`,
        )
      }
    }
    mounts.set(agent, { projectRoot, disposers, tools: names })
    if (names.length > 0) logger.info(`codegraph ready for ${projectRoot} (${names.length} tool(s))`)
  }

  /** 撤销一次挂载；逆序 dispose，与注册顺序对称。 */
  function unmount(mount) {
    for (const dispose of [...mount.disposers].reverse()) {
      try {
        dispose()
      } catch (error) {
        logger.warn(`could not unregister a codegraph tool: ${error.message}`)
      }
    }
    mount.disposers.length = 0
    mount.tools.length = 0
  }
}
