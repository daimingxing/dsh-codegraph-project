/**
 * 不经 DSH 验证 transport + pool + bridge：起真实 codegraph，握手，调用 tool，
 * 并确认同一项目多次 acquire 只起一个进程。
 *
 * 为了在不加载 Harness 的前提下复用插件代码，这里给 `ctx.subprocess` 造了一个
 * 最小实现（node:child_process + 与 SubprocessHandle 相同的方法面）。插件本体
 * 永远只用 DSH 提供的 ctx.subprocess；这份适配器仅存在于脚本里。
 *
 * 用法：
 *   node scripts/probe.mjs                        # 只验证 transport（步骤 2）
 *   node scripts/probe.mjs <项目根> <查询词>      # 追加验证 pool + bridge（步骤 3）
 */
import { spawn as spawnProcess } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, extname, resolve } from 'node:path'

import { createBridgedTool } from '../lib/bridge.js'
import { Pool } from '../lib/pool.js'
import { ManagedStdioTransport, resolveArgv } from '../lib/transport.js'

/** 与插件行配置默认值一致。 */
const config = {
  enabled: true,
  serverName: 'codegraph',
  codegraphBin: '',
  codegraphArgs: ['serve', '--mcp'],
  toolCallTimeoutMs: 120000,
  connectTimeoutMs: 15000,
  watchIntervalMs: 2000,
}

/**
 * 最小的 ctx.subprocess 实现：只覆盖 spawn 与 resolveExecutable。
 * 语义与 dsh-subprocess-local 对齐：argv 全量、stdio 三种模式、done 给结局、
 * terminate 走信号、waitForExit 等真实退出。
 */
const subprocess = {
  async resolveExecutable(command, env) {
    const pathValue = env?.PATH ?? process.env.PATH ?? ''
    const extensions =
      process.platform === 'win32' && extname(command) === ''
        ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
        : ['']
    for (const directory of pathValue.split(delimiter)) {
      for (const extension of extensions) {
        const candidate = resolve(process.cwd(), directory, command + extension)
        try {
          if (!statSync(candidate).isFile()) continue
          accessSync(candidate, constants.X_OK)
          return candidate
        } catch {
          // 继续找下一个候选。
        }
      }
    }
    throw new Error(`command ${JSON.stringify(command)} was not found on PATH`)
  },

  spawn(spec) {
    const child = spawnProcess(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: [
        spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe',
        spec.stdio.stdout === 'inherit' ? 'inherit' : 'pipe',
        spec.stdio.stderr === 'inherit' ? 'inherit' : 'pipe',
      ],
      windowsHide: true,
    })
    const done = new Promise((resolveDone, rejectDone) => {
      child.once('error', rejectDone)
      child.once('exit', (exitCode, signal) => resolveDone({ exitCode, signal }))
    })
    const exit = done.then(
      () => true,
      () => true,
    )
    return {
      pid: child.pid,
      stdin: child.stdin ?? undefined,
      stdout: child.stdout ?? undefined,
      stderr: child.stderr ?? undefined,
      control: undefined,
      collected: {},
      done,
      terminate: () => child.kill(),
      waitForExit: async () => exit,
    }
  },
}

/** 进程是否仍存活。 */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const warn = (message) => console.error(`[probe] warn: ${message}`)
const deps = { subprocess, config, warn }

/** 步骤 2：transport 单连接验收。 */
async function probeTransport(projectRoot) {
  const argv = await resolveArgv(subprocess, config)
  console.log(`[probe] argv=${JSON.stringify(argv)}`)
  console.log(`[probe] cwd=${projectRoot}`)

  const transport = new ManagedStdioTransport({
    subprocess,
    argv,
    cwd: projectRoot,
    label: projectRoot,
    connectTimeoutMs: config.connectTimeoutMs,
  })
  transport.onerror = (error) => console.error(`[probe] transport error: ${error.message}`)

  const startedAt = Date.now()
  const { serverInfo, tools } = await transport.start()
  const pid = transport.handle.pid
  console.log(`[probe] server=${JSON.stringify(serverInfo)} handshake=${Date.now() - startedAt}ms pid=${pid}`)
  console.log(`[probe] tools=${tools.map((tool) => tool.name).join(', ')}`)
  for (const tool of tools) {
    const properties = tool.inputSchema?.properties ?? {}
    console.log(
      `[probe]   ${tool.name}: props=[${Object.keys(properties).join(',')}]` +
        ` required=${JSON.stringify(tool.inputSchema?.required ?? [])}`,
    )
  }
  if (!tools.some((tool) => tool.name === 'codegraph_explore')) {
    throw new Error('codegraph_explore missing from tools/list')
  }
  console.log('[probe] OK: codegraph_explore present')

  const closedAt = Date.now()
  await transport.close()
  console.log(`[probe] close() returned in ${Date.now() - closedAt}ms`)
  // close() 只等进程退出；再确认一次 OS 层面已经不认这个 pid。
  await new Promise((resolveTick) => setTimeout(resolveTick, 200))
  const stillAlive = alive(pid)
  console.log(`[probe] process alive after close=${stillAlive}`)
  if (stillAlive) throw new Error('codegraph child process survived close()')
  console.log('[probe] OK: process gone after close()')
}

/** 步骤 3：pool + bridge 验收。 */
async function probePool(projectRoot, query) {
  const pool = new Pool(deps)
  const first = await pool.acquire(projectRoot)
  const firstPid = first.transport.handle.pid
  console.log(`[probe] pool.acquire#1 pid=${firstPid} refs=${first.references}`)

  // 同项目第二次 acquire：必须复用同一个进程，而不是再起一个。
  const second = await pool.acquire(projectRoot)
  const secondPid = second.transport.handle.pid
  console.log(`[probe] pool.acquire#2 pid=${secondPid} refs=${second.references}`)
  if (firstPid !== secondPid) throw new Error(`two acquire() calls started different processes: ${firstPid} vs ${secondPid}`)
  if (pool.list().length !== 1) throw new Error(`pool should hold exactly one hub, got ${pool.list().length}`)
  console.log('[probe] OK: same project shares one codegraph process')

  const tool = first.tools().find((entry) => entry.name === 'codegraph_explore')
  const bridged = createBridgedTool({
    publicName: `mcp__${config.serverName}__${tool.name}`,
    rawName: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    hub: first,
    timeoutMs: config.toolCallTimeoutMs,
  })
  console.log(`[probe] bridged tool=${bridged.name} timeoutMs=${bridged.timeoutMs}`)
  console.log(`[probe] parameters=${JSON.stringify(bridged.parameters)}`)

  const startedAt = Date.now()
  const result = await bridged.execute({ query }, { signal: AbortSignal.timeout(config.toolCallTimeoutMs) })
  const text = result.content.map((block) => block.text).join('\n')
  console.log(`[probe] call took ${Date.now() - startedAt}ms, ${text.length} chars`)
  console.log(`[probe] answer head:\n${text.slice(0, 1200)}`)
  const rendered = bridged.output.render({ query }, result)
  console.log(`[probe] render() produced ${rendered.length} block(s), ${rendered[0].text.length} chars`)
  if (text.length === 0) throw new Error('codegraph returned empty content')

  // 引用计数：两次 release 之后才关进程。
  await pool.release(projectRoot)
  console.log(`[probe] after release#1 refs=${first.references} alive=${alive(firstPid)}`)
  if (!alive(firstPid)) throw new Error('codegraph process closed while another session still holds a reference')
  await pool.release(projectRoot)
  await new Promise((resolveTick) => setTimeout(resolveTick, 200))
  console.log(`[probe] after release#2 hubs=${pool.list().length} alive=${alive(firstPid)}`)
  if (alive(firstPid)) throw new Error('codegraph process survived the last release()')
  if (pool.list().length !== 0) throw new Error(`pool should be empty after the last release, got ${pool.list().length}`)
  console.log('[probe] OK: reference counting closes the process exactly once')
}

const projectRoot = process.argv[2] ?? process.cwd()
const query = process.argv[3] ?? 'main'
if (!existsSync(projectRoot)) throw new Error(`project root does not exist: ${projectRoot}`)

let failed = false
try {
  await probeTransport(projectRoot)
  await probePool(projectRoot, query)
} catch (error) {
  console.error(`[probe] FAILED: ${error.message}`)
  failed = true
}
process.exitCode = failed ? 1 : 0
