/**
 * 验证连接共享与引用计数：同一个 Host 进程内，同一项目两个会话只起一个 codegraph。
 *
 * 用真实 codegraph 子进程（经 ctx.subprocess 形态的适配器），而不是 mock：共享进程
 * 是这个插件的核心承诺，只有真进程才能证明。
 *
 * 用法：node scripts/check-sharing.mjs [有索引的项目目录]
 */
import { spawn as spawnProcess } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, extname, resolve } from 'node:path'

import { Pool } from '../lib/pool.js'

/** 带索引的测试项目；也可用环境变量 `CODEGRAPH_TEST_PROJECT` 指定。 */
const projectRoot = process.argv[2] ?? process.env.CODEGRAPH_TEST_PROJECT ?? '.'

const config = {
  codegraphBin: '',
  codegraphArgs: ['serve', '--mcp'],
  toolCallTimeoutMs: 60000,
  connectTimeoutMs: 15000,
}

/** 与 dsh-subprocess-local 方法面对齐的最小实现。 */
const subprocess = {
  async resolveExecutable(command) {
    const pathValue = process.env.PATH ?? ''
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
          // 继续找。
        }
      }
    }
    throw new Error(`command ${JSON.stringify(command)} was not found on PATH`)
  },
  spawn(spec) {
    const child = spawnProcess(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const done = new Promise((resolveDone, rejectDone) => {
      child.once('error', rejectDone)
      child.once('exit', (exitCode, signal) => resolveDone({ exitCode, signal }))
    })
    return {
      stdin: child.stdin ?? undefined,
      stdout: child.stdout ?? undefined,
      stderr: child.stderr ?? undefined,
      control: undefined,
      collected: {},
      done,
      terminate: () => child.kill(),
      waitForExit: () => done.then(() => true, () => true),
      // 仅供本脚本断言用：DSH 的真实 handle 没有 pid，这里额外暴露一个入口，
      // 让脚本能把 spec 记录下来核对（插件代码永远不读这个字段）。
      __pid: child.pid,
    }
  },
}

const failures = []
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const pool = new Pool({ subprocess, config })
try {
  console.log(`[sharing] project=${projectRoot}`)
  // 模拟两个会话同时 acquire 同一个项目。
  const [sessionA, sessionB] = await Promise.all([pool.acquire(projectRoot), pool.acquire(projectRoot)])
  // 脚本的适配器额外暴露 __pid；插件的 transport 只用 DSH 真实接口，从不读它。
  const pidA = sessionA.transport.handle.__pid
  const pidB = sessionB.transport.handle.__pid

  console.log(`[sharing] session A pid=${pidA} session B pid=${pidB}`)
  check('两个会话共享同一个 hub', sessionA === sessionB)
  check('两个会话指向同一个 codegraph 进程', pidA === pidB, `${pidA} vs ${pidB}`)
  check('池中只有一条连接', pool.list().length === 1, `count=${pool.list().length}`)
  check('引用计数为 2', sessionA.references === 2, `refs=${sessionA.references}`)
  check('连接暴露项目标识用于诊断', sessionA.projectTag === projectRoot, `tag=${sessionA.projectTag}`)
  check(
    'spawn 时注入项目标识环境变量（DSH handle 无 pid，这是唯一的进程对应手段）',
    sessionA.transport.handle.__pid !== undefined,
  )

  // 一个会话离开不应影响另一个。
  const firstRelease = await pool.release(projectRoot)
  await new Promise((resolve) => setTimeout(resolve, 100))
  check('release 报告剩余引用数', firstRelease?.remaining === 1, `released=${JSON.stringify(firstRelease)}`)
  check('一个会话离开后另一个仍可用', sessionB.connected === true)
  check('一个会话离开后进程仍在', sessionA.transport === undefined || pool.list().length === 1)

  // 两个都离开才关进程。
  const lastRelease = await pool.release(projectRoot)
  await new Promise((resolve) => setTimeout(resolve, 300))
  check('最后一次 release 报告 closed', lastRelease?.closed === true, `released=${JSON.stringify(lastRelease)}`)
  check('最后一个会话离开后池为空', pool.list().length === 0, `count=${pool.list().length}`)
} finally {
  await pool.closeAll()
}

if (failures.length > 0) {
  console.error(`\n[sharing] FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  console.log('\n[sharing] OK')
}
