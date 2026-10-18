/**
 * 验证失败上报的去重与恢复行为。
 *
 * 直接驱动 index.js 的 apply()，用一个假 Host 语境（含 logger）记录日志，避免依赖
 * 真实 LLM 轮次。重点验证报告问题 3：同样失败不刷屏、恢复后复发仍会告警。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

const root = mkdtempSync(join(tmpdir(), 'cg-fail-'))
const project = join(root, 'project')
mkdirSync(join(project, '.codegraph'), { recursive: true })
writeFileSync(join(project, '.codegraph', 'codegraph.db'), '')

const logs = []
const listeners = new Map()

/** 最小 Host 语境：只提供 apply() 用到的那几个成员。 */
function fakeContext() {
  // Cordis 的 ctx.logger 本身可调用（ctx.logger(name) 取具名 logger），所以既要能
  // 当函数调用，也要有 info/warn/error/debug 方法。
  const logger = (scope) => ({
    info: (message) => logs.push(['info', `${scope}: ${message}`]),
    warn: (message) => logs.push(['warn', `${scope}: ${message}`]),
    error: (message) => logs.push(['error', `${scope}: ${message}`]),
    debug: (message) => logs.push(['debug', `${scope}: ${message}`]),
  })
  Object.assign(logger, logger('root'))
  return {
    logger,
    subprocess: {
      // 可执行的探测永远失败：模拟 codegraph 没装 / .cmd 布局不对。
      async resolveExecutable() {
        throw new Error('codegraph was not found on PATH')
      },
      spawn() {
        throw new Error('should not reach spawn when resolveExecutable fails')
      },
    },
    effect(fn) {
      const dispose = fn()
      return dispose
    },
    get(name) {
      if (name === 'workingDirectory') {
        return { get: () => project }
      }
      return undefined
    },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => {}
    },
  }
}

/** 构造一个最小 agent：需要 session.id、session.header.cwd、ctx.on 与 ctx.tools.register。 */
const toolRegistrations = []
function fakeAgent() {
  const agentListeners = new Map()
  return {
    session: { id: 'session-test', header: { cwd: project } },
    ctx: {
      on(event, listener) {
        agentListeners.set(event, [...(agentListeners.get(event) ?? []), listener])
        return () => {}
      },
      tools: {
        register(definition) {
          toolRegistrations.push(definition.name)
          return () => {}
        },
      },
    },
    __listeners: agentListeners,
  }
}

/** 触发某类事件的全部监听器。 */
async function fire(event, payload) {
  for (const listener of listeners.get(event) ?? []) await listener(payload)
}
async function fireAgent(agent, event, payload) {
  const preStep = agent.__listeners.get(event) ?? []
  for (const listener of preStep) {
    // pre-step 是 waterfall：提供 next() 让它继续。
    await listener(payload, () => Promise.resolve({ kind: 'enter', messages: [] }))
  }
}

const ctx = fakeContext()
apply(ctx, {
  enabled: true,
  serverName: 'codegraph',
  codegraphBin: '',
  codegraphArgs: ['serve', '--mcp'],
  toolCallTimeoutMs: 60000,
  connectTimeoutMs: 5000,
  watchIntervalMs: 0,
})

const agent = fakeAgent()
await fire('agent/created', { agent })

const failures = []
function check(name, condition, detail) {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures.push(name)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const unavailableLogs = () => logs.filter(([, message]) => message.includes('codegraph unavailable'))

check('启动失败会上报一次', unavailableLogs().length === 1, `count=${unavailableLogs().length}`)
check('失败日志带上项目与原因', unavailableLogs()[0]?.[1]?.includes(project) === true, JSON.stringify(unavailableLogs()[0]))
check('失败日志提示会继续重试', unavailableLogs()[0]?.[1]?.includes('Will keep retrying') === true)
check('失败时没有注册任何工具', toolRegistrations.length === 0, `tools=${JSON.stringify(toolRegistrations)}`)

// 再跑多个 step：同样的失败不应重复刷日志。
for (let step = 0; step < 5; step += 1) {
  await fireAgent(agent, 'agent/pre-step', { agent, turn: 1, step })
}
check('重复重试不刷屏（仍只有 1 条）', unavailableLogs().length === 1, `count=${unavailableLogs().length}`)

// 会话销毁路径应写 debug 日志而不是静默。
const beforeDisposed = logs.length
await fire('agent/disposed', { agent })
const disposedLogs = logs.slice(beforeDisposed)
check(
  '未挂载的会话销毁时不产生误导性释放日志',
  disposedLogs.every(([, message]) => !message.includes('released codegraph')),
  JSON.stringify(disposedLogs),
)

rmSync(root, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n[failure-reporting] FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  console.log('\n[failure-reporting] OK')
}
