import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

/**
 * 这一组测试锁住「注入 CodeGraph 使用指引」的全部行为，重点是**降级路径**：
 * 任何一步失败都必须退化成「少一段提示」，而不是「工具不可用」或「会话报错」。
 *
 * 为什么用假 Host 而不是真 Host：这些分支（无 systemPrompt 服务、section 注册冲突、
 * 超限）在真机装配里极难构造，而它们恰恰是唯一会让「提示词功能」伤到「工具功能」
 * 的地方，必须逐条覆盖。
 */

/** 一份与真实 CodeGraph 1.6.2 同形的指引文本。 */
const INSTRUCTIONS = [
  '# Codegraph — code intelligence over an indexed knowledge graph',
  '',
  '## One tool: codegraph_explore — use it instead of reading files',
  '',
  'Explore matches names and indexed code words lexically, not by meaning.',
].join('\n')

const TOOLS = [{ name: 'codegraph_explore', description: 'PRIMARY TOOL', inputSchema: { type: 'object', properties: {} } }]

/**
 * 最小 Host 语境。
 *
 * @param {object} options
 * @param {string} [options.instructions] 服务端在 initialize 里返回的指引
 * @param {boolean} [options.systemPrompt] 是否挂载 systemPrompt 服务
 * @param {Error} [options.sectionError] 让 section() 抛这个错（模拟重名冲突）
 */
function fakeHost({ instructions = INSTRUCTIONS, systemPrompt = true, sectionError } = {}) {
  const logs = []
  const listeners = new Map()
  /** 记录所有注册过的 section，便于断言作用域与内容。 */
  const sections = []
  const spawned = []

  const logger = (scope) => {
    const at = (level) => (message) => logs.push([level, `${scope}: ${message}`])
    return { info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') }
  }
  Object.assign(logger, logger('root'))

  function fakeHandle() {
    let resolveDone
    const done = new Promise((resolve) => {
      resolveDone = resolve
    })
    const handle = {
      stdin: {
        write(line) {
          const message = JSON.parse(String(line))
          if (message.id === undefined) return
          const result =
            message.method === 'initialize'
              ? {
                  protocolVersion: '2024-11-05',
                  capabilities: { tools: {} },
                  serverInfo: { name: 'codegraph', version: '1.6.2' },
                  instructions,
                }
              : message.method === 'tools/list'
                ? { tools: TOOLS }
                : {}
          setImmediate(() => handle.stdout.push(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`))
        },
        end() {
          setImmediate(() => resolveDone({ exitCode: 0, signal: null }))
        },
      },
      stdout: fakeReadable(),
      stderr: fakeReadable(),
      done,
      terminate() {
        resolveDone({ exitCode: null, signal: 'SIGTERM' })
      },
      waitForExit: () => done.then(() => true, () => true),
    }
    return handle
  }

  const subprocess = {
    spawned,
    async resolveExecutable() {
      return 'C:\\fake\\codegraph.exe'
    },
    spawn(spec) {
      spawned.push(spec)
      return fakeHandle()
    },
  }

  const sectionService = {
    getSectionOrder: (name) => (name === 'MCP_SERVERS' ? 3100 : 0),
    section(definition) {
      if (sectionError !== undefined) throw sectionError
      sections.push(definition)
      return () => {
        const index = sections.indexOf(definition)
        if (index >= 0) sections.splice(index, 1)
      }
    },
  }

  const tools = {
    registered: [],
    register(tool) {
      if (tools.registerError !== undefined) throw tools.registerError
      tools.registered.push(tool)
      return () => {}
    },
  }

  /**
   * 一个会话语境。
   *
   * `get(name)` 在这里被刻意实现成「返回绑定到本 ctx 的服务」——这正是 Cordis
   * `createTraceable` 的行为，也是插件必须从 `agent.ctx` 取服务的原因：
   * 用插件 ctx 取，section 就会挂成全局。
   */
  function agentCtx() {
    const inner = {
      get: (serviceName) => (serviceName === 'systemPrompt' && systemPrompt ? sectionService : undefined),
      // 动态读 ctx.tools，而不是闭包捕获：测试需要能替换掉 register 来模拟冲突。
      get tools() {
        return ctx.tools
      },
      on(event, listener) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
        return () => {}
      },
    }
    return inner
  }

  const ctx = {
    logger,
    subprocess,
    tools,
    get: (serviceName) => (serviceName === 'systemPrompt' && systemPrompt ? sectionService : undefined),
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return dispose ?? (() => {})
    },
  }

  return { ctx, logs, listeners, sections, spawned, agentCtx }
}

/** 可控的只读流。 */
function fakeReadable() {
  const listeners = new Map()
  return {
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return this
    },
    push(chunk) {
      for (const listener of listeners.get('data') ?? []) listener(Buffer.from(chunk))
    },
  }
}

const BASE_CONFIG = {
  enabled: true,
  serverName: 'codegraph',
  codegraphBin: 'C:\\fake\\codegraph.exe',
  codegraphArgs: ['serve', '--mcp'],
  toolCallTimeoutMs: 5000,
  connectTimeoutMs: 5000,
  watchIntervalMs: 0,
  injectInstructions: true,
  maxInstructionBytes: 32768,
}

/** 建一个带 .codegraph 索引的临时项目，并跑一次挂载。 */
async function mountOnce(t, configOverrides = {}, hostOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cg-instr-'))
  const project = join(root, 'project')
  mkdirSync(join(project, '.codegraph'), { recursive: true })
  writeFileSync(join(project, '.codegraph', 'codegraph.db'), '')
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const host = fakeHost(hostOptions)
  const config = { ...BASE_CONFIG, ...configOverrides }
  apply(host.ctx, config)

  // agent/created 的第一个监听器负责挂载，第二个负责装 pre-step 钩子。
  const agent = { session: { header: { cwd: project } }, ctx: host.agentCtx() }
  for (const listener of host.listeners.get('agent/created') ?? []) {
    await listener({ agent, signal: undefined })
  }
  return { host, agent, project }
}

test('正常路径：注入一段带官方前缀的 section，并注册工具', async (t) => {
  const { host } = await mountOnce(t)

  assert.equal(host.sections.length, 1, '应当只注册一个 section')
  const [section] = host.sections
  assert.equal(section.name, 'mcp:codegraph')
  assert.equal(section.order, 3100, '必须与官方 MCP_SERVERS 排序位一致')
  assert.equal(section.interpolate, false, '必须是字面量，避免上游 {{}} 让 assemble 抛错')

  const text = section.text()
  assert.match(text, /^### MCP server: codegraph\n\n# Codegraph — code intelligence/)
  assert.match(text, /Explore matches names and indexed code words lexically/)

  assert.equal(host.spawned.length, 1, '应当起了 codegraph 子进程')
})

test('section.text 是函数：重连后取当前值而不是快照', async (t) => {
  const { host } = await mountOnce(t)
  const [section] = host.sections
  assert.equal(typeof section.text, 'function', 'text 必须是函数，不能是字符串快照')
})

test('降级：服务端没给 instructions 时不注册 section，但工具照常', async (t) => {
  const { host } = await mountOnce(t, {}, { instructions: '' })

  assert.equal(host.sections.length, 0, '没有指引就不该有 section')
  assert.equal(host.spawned.length, 1, '工具链路不受影响')
})

test('降级：injectInstructions=false 时完全不注册 section', async (t) => {
  const { host } = await mountOnce(t, { injectInstructions: false })

  assert.equal(host.sections.length, 0)
})

test('降级：超过 maxInstructionBytes 时跳过并告警，不抛错', async (t) => {
  const { host } = await mountOnce(t, { maxInstructionBytes: 10 })

  assert.equal(host.sections.length, 0, '超限必须跳过注入')
  const warnings = host.logs.filter(([level]) => level === 'warn').map(([, message]) => message)
  assert.equal(warnings.length, 1, '超限应当告警一次')
  assert.match(warnings[0], /exceeds maxInstructionBytes/)
  assert.match(warnings[0], /Tools are unaffected/, '告警要说明工具不受影响')
})

test('降级：没有 systemPrompt 服务时跳过，不抛错', async (t) => {
  const { host } = await mountOnce(t, {}, { systemPrompt: false })

  assert.equal(host.sections.length, 0)
  assert.equal(host.spawned.length, 1, '没有 systemPrompt 也必须能起工具')
})

test('降级：section 注册抛错（同名冲突）时告警并继续注册工具', async (t) => {
  const { host } = await mountOnce(t, {}, { sectionError: new Error('prompt section "mcp:codegraph" is already registered') })

  assert.equal(host.sections.length, 0)
  const warnings = host.logs.filter(([level]) => level === 'warn').map(([, message]) => message)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /could not inject codegraph instructions/)
  assert.match(warnings[0], /Tools are unaffected/)
})

test('工具一个都没注册成功时不注入指引', async (t) => {
  // 指引讲的是 codegraph_explore 怎么用。若该工具因命名冲突没注册上，注入指引等于
  // 让模型去找一个不存在的工具——比没有指引更糟。
  const root = mkdtempSync(join(tmpdir(), 'cg-nointr-'))
  const project = join(root, 'project')
  mkdirSync(join(project, '.codegraph'), { recursive: true })
  writeFileSync(join(project, '.codegraph', 'codegraph.db'), '')
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const host = fakeHost()
  host.ctx.tools = {
    registerError: new Error('tool name conflict'),
    register() {
      throw host.ctx.tools.registerError
    },
  }
  apply(host.ctx, { ...BASE_CONFIG })

  const agent = { session: { header: { cwd: project } }, ctx: host.agentCtx() }
  for (const listener of host.listeners.get('agent/created') ?? []) {
    await listener({ agent, signal: undefined })
  }

  assert.equal(host.sections.length, 0, '没有可用工具时不该注入指引')
})

test('指引注册在会话 scope，不是全局 scope', async (t) => {
  // 这是整个设计最容易出错的一处：从插件 ctx 取 systemPrompt 会挂成全局 section，
  // 于是无索引的会话也会看到 codegraph 指引。这里断言取服务用的是 agent.ctx。
  const root = mkdtempSync(join(tmpdir(), 'cg-scope-'))
  const project = join(root, 'project')
  mkdirSync(join(project, '.codegraph'), { recursive: true })
  writeFileSync(join(project, '.codegraph', 'codegraph.db'), '')
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const host = fakeHost()
  const globalSectionCalls = []
  // 插件 ctx 上的 systemPrompt：一旦被用来注册，就说明作用域错了。
  const pluginLevel = {
    getSectionOrder: () => 3100,
    section: (definition) => {
      globalSectionCalls.push(definition)
      return () => {}
    },
  }
  const originalGet = host.ctx.get
  host.ctx.get = (serviceName) => (serviceName === 'systemPrompt' ? pluginLevel : originalGet(serviceName))

  apply(host.ctx, { ...BASE_CONFIG })
  const agent = { session: { header: { cwd: project } }, ctx: host.agentCtx() }
  for (const listener of host.listeners.get('agent/created') ?? []) {
    await listener({ agent, signal: undefined })
  }

  assert.equal(globalSectionCalls.length, 0, '不得通过插件 ctx 注册 section（那会变成全局）')
  assert.equal(host.sections.length, 1, '应当通过 agent.ctx 注册')
})
