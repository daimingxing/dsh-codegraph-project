/**
 * 探测 CodeGraph 的 MCP `initialize` 响应里到底带了什么 instructions。
 *
 * 这是本插件「注入 instructions」功能的原始依据：不靠文档、不靠印象，直接对真实
 * 项目起一个 `codegraph serve --mcp` 子进程，读握手响应。
 *
 * 用法：
 *   node scripts/probe-instructions.mjs <项目目录> [更多项目目录...]
 *
 * 输出每个项目的：serverInfo、instructions 字节数、首尾片段、是否含 `{{`
 * （含 `{{` 会让 DSH 的提示词插值抛错，因此这是安全相关的检查项）。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** npm 全局布局里 codegraph 的原生包位置（Windows）。 */
const NPM_GLOBAL = join(process.env.APPDATA ?? '', 'npm', 'node_modules')
const PKG = join(NPM_GLOBAL, '@colbymchenry', 'codegraph')
const PLATFORM_PKG = join(
  PKG,
  'node_modules',
  '@colbymchenry',
  `codegraph-${process.platform}-${process.arch}`,
)
const NODE_EXE = join(PLATFORM_PKG, 'node.exe')
const ENTRY = join(PLATFORM_PKG, 'lib', 'dist', 'bin', 'codegraph.js')

/** 单项目超时：握手应该秒回，卡住就是环境问题。 */
const TIMEOUT_MS = 25000

function launch(cwd) {
  const child = spawn(NODE_EXE, [ENTRY, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4096)
  })

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  let buffer = ''

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`timed out after ${TIMEOUT_MS}ms; stderr: ${stderr.trim() || '(empty)'}`))
    }, TIMEOUT_MS)

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line === '') continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id === 1) {
          clearTimeout(timer)
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
          resolve({ initialize: message.result })
        }
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'probe-instructions', version: '0' },
    },
  })

  return { done, close: () => child.stdin.end() }
}

const projects = process.argv.slice(2)
if (projects.length === 0) {
  console.error('usage: node scripts/probe-instructions.mjs <project-dir> [...]')
  process.exit(2)
}
if (!existsSync(NODE_EXE) || !existsSync(ENTRY)) {
  console.error(`cannot find codegraph runtime at ${PLATFORM_PKG}`)
  process.exit(2)
}

for (const project of projects) {
  console.log(`\n=== ${project} ===`)
  if (!existsSync(join(project, '.codegraph'))) {
    console.log('  (no .codegraph index — server will send the no-root-index variant)')
  }
  const { done, close } = launch(project)
  try {
    const { initialize } = await done
    const instructions = initialize.instructions ?? ''
    console.log('  serverInfo   :', JSON.stringify(initialize.serverInfo))
    console.log('  capabilities :', JSON.stringify(initialize.capabilities))
    console.log('  instructions :', Buffer.byteLength(instructions), 'bytes')
    console.log('  contains {{  :', instructions.includes('{{'))
    console.log('  contains }}  :', instructions.includes('}}'))
    console.log('  first line   :', JSON.stringify(instructions.split('\n')[0] ?? ''))
    console.log('  last 2 lines :', JSON.stringify(instructions.trimEnd().split('\n').slice(-2).join('\n')))
  } catch (error) {
    console.log('  FAILED:', error.message)
  } finally {
    close()
  }
}
