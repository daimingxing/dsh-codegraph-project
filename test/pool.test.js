import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Pool } from '../lib/pool.js'

/** 最小的 ctx.subprocess 替身：每次 spawn 记录一个 spec，close 记一次退出。 */
function fakeSubprocess() {
  const spawned = []
  return {
    spawned,
    async resolveExecutable() {
      return 'C:\\fake\\codegraph.exe'
    },
    spawn(spec) {
      const record = { spec, terminated: false, stdinEnded: false, closed: false }
      spawned.push(record)
      let resolveDone
      const done = new Promise((resolve) => {
        resolveDone = resolve
      })
      // 只暴露 DSH SubprocessHandle 真实存在的成员：接口里没有 pid，
      // 测试替身也不该有，否则会掩盖「pid 拿不到」这个平台事实。
      const handle = {
        stdin: {
          write() {},
          end() {
            record.stdinEnded = true
            // 与 CodeGraph 实测行为一致：stdin EOF 后自行退出。
            setImmediate(() => {
              record.closed = true
              resolveDone({ exitCode: 0, signal: null })
            })
          },
        },
        stdout: fakeReadable(),
        stderr: fakeReadable(),
        control: undefined,
        collected: {},
        done,
        terminate() {
          record.terminated = true
          record.closed = true
          resolveDone({ exitCode: null, signal: 'SIGTERM' })
        },
        waitForExit: () => done.then(() => true, () => true),
      }
      // MCP 握手需要 stdout 回帧：这里让 transport.start() 走真实实现，
      // 所以按请求 id 回一张最小响应。
      handle.stdin.write = (line) => {
        const message = JSON.parse(String(line))
        if (message.id === undefined) return
        const result =
          message.method === 'initialize'
            ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake' } }
            : message.method === 'tools/list'
              ? { tools: [{ name: 'codegraph_explore', description: 'x', inputSchema: { type: 'object', properties: {} } }] }
              : {}
        setImmediate(() => handle.stdout.push(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`))
      }
      return handle
    },
  }
}

/** 可控的只读流，模拟子进程 stdout。 */
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

const config = {
  codegraphBin: '',
  codegraphArgs: ['serve', '--mcp'],
  toolCallTimeoutMs: 5000,
  connectTimeoutMs: 5000,
  watchIntervalMs: 2000,
}

test('同项目两次 acquire 共享一个进程，引用计数为 2', async (t) => {
  const subprocess = fakeSubprocess()
  const pool = new Pool({ subprocess, config })
  t.after(() => pool.closeAll())

  const first = await pool.acquire('C:\\project')
  const second = await pool.acquire('C:\\project')

  assert.equal(first, second)
  assert.equal(first.references, 2)
  assert.equal(subprocess.spawned.length, 1)
  assert.equal(pool.list().length, 1)
})

test('引用归零才关进程；最后一个 release 之后池为空', async (t) => {
  const subprocess = fakeSubprocess()
  const pool = new Pool({ subprocess, config })
  t.after(() => pool.closeAll())

  await pool.acquire('C:\\project')
  await pool.acquire('C:\\project')

  await pool.release('C:\\project')
  assert.equal(subprocess.spawned[0].closed, false, '还有引用时不应关闭进程')
  assert.equal(subprocess.spawned.length, 1)

  await pool.release('C:\\project')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(subprocess.spawned[0].closed, true)
  assert.equal(pool.list().length, 0)
})

test('归零后再 acquire 会起新进程，不复用已关闭的 hub', async (t) => {
  const subprocess = fakeSubprocess()
  const pool = new Pool({ subprocess, config })
  t.after(() => pool.closeAll())

  await pool.acquire('C:\\project')
  await pool.release('C:\\project')
  await pool.acquire('C:\\project')

  assert.equal(subprocess.spawned.length, 2)
  assert.equal(subprocess.spawned[1].closed, false)
})

test('连接失败时清理进程与池记录，允许下一次重试', async (t) => {
  let attempts = 0
  const subprocess = fakeSubprocess()
  const failing = {
    ...subprocess,
    spawn(spec) {
      attempts += 1
      const handle = subprocess.spawn(spec)
      if (attempts === 1) {
        // 首轮：不回应握手，让 connect 超时失败。
        handle.stdin.write = () => {}
        return handle
      }
      return handle
    },
  }
  const pool = new Pool({ subprocess: failing, config: { ...config, connectTimeoutMs: 60 } })
  t.after(() => pool.closeAll())

  await assert.rejects(pool.acquire('C:\\project'), /cannot start codegraph|timed out/)
  assert.equal(pool.list().length, 0, '失败的 hub 必须从池中移除')

  const hub = await pool.acquire('C:\\project')
  assert.equal(hub.connected, true)
  assert.equal(pool.list().length, 1)
})

test('并发 acquire 只起一个进程', async (t) => {
  const subprocess = fakeSubprocess()
  const pool = new Pool({ subprocess, config })
  t.after(() => pool.closeAll())

  const hubs = await Promise.all([pool.acquire('C:\\p'), pool.acquire('C:\\p'), pool.acquire('C:\\p')])

  assert.equal(subprocess.spawned.length, 1)
  assert.equal(hubs[0], hubs[1])
  assert.equal(hubs[0].references, 3)
})

test('不同项目各自独立', async (t) => {
  const subprocess = fakeSubprocess()
  const pool = new Pool({ subprocess, config })
  t.after(() => pool.closeAll())

  const a = await pool.acquire('C:\\a')
  const b = await pool.acquire('C:\\b')

  assert.notEqual(a, b)
  assert.equal(subprocess.spawned.length, 2)
  assert.equal(subprocess.spawned[0].spec.cwd, 'C:\\a')
  assert.equal(subprocess.spawned[1].spec.cwd, 'C:\\b')
})

test('closeAll 关闭全部连接', async (t) => {
  const subprocess = fakeSubprocess()
  const pool = new Pool({ subprocess, config })
  t.after(() => pool.closeAll())

  await pool.acquire('C:\\a')
  await pool.acquire('C:\\b')
  await pool.closeAll()

  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(pool.list().length, 0)
  assert.equal(subprocess.spawned.every((record) => record.closed), true)
})

test('release 返回剩余引用数，供会话销毁路径写诊断日志', async (t) => {
  const subprocess = fakeSubprocess()
  const pool = new Pool({ subprocess, config })
  t.after(() => pool.closeAll())

  await pool.acquire('C:\\project')
  await pool.acquire('C:\\project')

  const first = await pool.release('C:\\project')
  assert.deepEqual(first, { remaining: 1, closed: false })

  const last = await pool.release('C:\\project')
  assert.deepEqual(last, { remaining: 0, closed: true })

  // 重复释放（异常路径）不应误报剩余引用。
  assert.equal(await pool.release('C:\\project'), undefined)
})

test('连接携带项目标识，用于把日志行与 OS 进程对应', async (t) => {
  const subprocess = fakeSubprocess()
  const pool = new Pool({ subprocess, config })
  t.after(() => pool.closeAll())

  const hub = await pool.acquire('C:\\project')

  // 不是 pid：DSH 的 SubprocessHandle 不暴露 pid（实测确认）。
  assert.equal(hub.projectTag, 'C:\\project')
  assert.equal('pid' in hub, false, 'handle 没有 pid，hub 不应假装能提供')

  // 子进程环境变量带同一个标识：可从进程环境反查项目。
  assert.equal(subprocess.spawned[0].spec.env?.DSH_CODEGRAPH_PROJECT, 'C:\\project')
})

test('未连接时不暴露项目标识与 stderr', async (t) => {
  const subprocess = fakeSubprocess()
  const pool = new Pool({ subprocess, config })
  t.after(() => pool.closeAll())

  const hub = await pool.acquire('C:\\project')
  await pool.release('C:\\project')

  assert.equal(hub.projectTag, undefined)
  assert.equal(hub.stderrTail, '')
})
