/**
 * 真机验收探针（不依赖 LLM）。
 *
 * headless profile 缺 LLM 凭证，跑不到模型轮次，所以这里用探针在真实 DSH Host 装配
 * 中读取插件产生的可观察状态：会话可见工具列表，以及此刻由插件托管的 codegraph
 * 子进程数量。结论写入 DSH_CODEGRAPH_ACCEPTANCE_RESULT，由 scripts/acceptance.mjs 断言。
 *
 * 进程数量必须在会话存续期间采样：headless 是一次性进程，跑完就退，外部再统计只会
 * 得到 0。
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

export const name = 'codegraph-acceptance-probe'
export const inject = ['tools']

const steps = []

function record(stage) {
  const path = process.env.DSH_CODEGRAPH_ACCEPTANCE_RESULT
  if (path === undefined) return
  writeFileSync(path, JSON.stringify({ stage, steps }, null, 2), 'utf8')
}

/** 只读的判断：哪些 mcp__codegraph__* 工具对该 agent 可见。 */
function codegraphTools(ctx, agent) {
  return ctx.tools
    .schemas(agent)
    .map((schema) => schema.name)
    .filter((toolName) => toolName.startsWith('mcp__codegraph__'))
}

/**
 * 本进程后代里，有几个是插件拉起的 codegraph。
 *
 * 不能用「直接子进程」：Windows 上 ctx.subprocess 经 Job runner 中转，真正的
 * codegraph 进程挂在更深一层，ParentProcessId 并不指向 Host。这里求完整后代闭包，
 * 再按命令行区分——CodeGraph 自己的后台 daemon 由用户更早启动，不在本进程后代里。
 */
function pluginChildCount() {
  const script = [
    `$root = ${process.pid}`,
    '$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine',
    '$set = [System.Collections.Generic.HashSet[int]]::new()',
    '$null = $set.Add($root)',
    'do { $added = $false; foreach ($p in $all) {',
    '  if ($set.Contains([int]$p.ParentProcessId) -and -not $set.Contains([int]$p.ProcessId)) {',
    '    $null = $set.Add([int]$p.ProcessId); $added = $true } } } while ($added)',
    '$set.Remove($root) | Out-Null',
    '($all | Where-Object { $set.Contains([int]$_.ProcessId) -and $_.CommandLine -like "*codegraph.js*" }).Count',
  ].join('; ')
  try {
    const count = Number.parseInt(
      String(execFileSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' })).trim(),
      10,
    )
    return Number.isNaN(count) ? 0 : count
  } catch {
    return -1
  }
}

/**
 * 读取该会话真正会发给模型的 system prompt section 快照。
 *
 * 这是「注入 instructions」功能的唯一可信证据：不看插件内部状态，而是调用
 * `systemPrompt.assemble()` —— 与 agent-loop 组装请求时完全同一条路径 —— 再从中
 * 挑出 codegraph 相关的 section。若作用域挂错（挂成全局），无索引会话也会出现，
 * 因此这个函数同时服务于「有」和「无」两侧的断言。
 */
async function promptSections(ctx, agent) {
  const systemPrompt = agent.ctx.get('systemPrompt')
  if (systemPrompt === undefined) return { available: false, sections: [] }
  const assembly = await systemPrompt.assemble({ agent, scope: agent })
  const codegraph = assembly.sections
    .filter((section) => section.name.startsWith('mcp:'))
    .map((section) => ({
      name: section.name,
      bytes: Buffer.byteLength(section.text, 'utf8'),
      // 只留特征片段：完整 6.8KB 写进结果文件没有意义，断言用前几行足够。
      head: section.text.split('\n').slice(0, 3).join('\n'),
    }))
  return { available: true, sections: codegraph }
}

export function apply(ctx) {
  record('applied')

  ctx.on('agent/created', ({ agent }) => {
    steps.push({ at: 'created', cwd: agent.session?.header?.cwd, tools: codegraphTools(ctx, agent) })
    record('created')
  })

  // pre-step 在插件完成挂载之后才跑：这里读到的工具列表就是本轮真正会发给模型的集合。
  ctx.on('agent/pre-step', async (payload, next) => {
    const prompt = await promptSections(ctx, payload.agent)
    steps.push({
      at: 'pre-step',
      cwd: payload.agent.session?.header?.cwd,
      tools: codegraphTools(ctx, payload.agent),
      children: pluginChildCount(),
      prompt,
    })
    record('pre-step')
    return next()
  })
}
