/**
 * 真机验收：在真实 DSH Host 装配里验证 codegraph-project 的可观察行为。
 *
 * 为什么不走模型轮次：headless profile 缺 LLM 凭证，跑不到工具调用那一步。这里改为
 * 检查插件在 Host 内部产生的状态（会话可见工具列表）与操作系统层面的进程事实，
 * 足以判定 docs/implementation-plan.md 验收清单中不依赖模型输出的各项。
 *
 * 用法：node scripts/acceptance.mjs
 * 退出码 0 表示全部通过；失败项会打印原因。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const HERE = dirname(new URL(import.meta.url).pathname.slice(1))
/** dsh CLI 入口；Windows 安装在默认位置，其他环境用 `DSH_BIN` 覆盖。 */
const DSH_BIN = process.env.DSH_BIN ?? 'C:\\deepseek-harness-desktop\\resources\\runtime\\cli\\bin\\dsh.cmd'
const PROFILE = 'headless'
const OVERLAY = join(HERE, '..', 'test', 'fixtures', 'acceptance-overlay.yml')
const PLUGIN_DIR = join(HERE, '..')
const PROBE_DIR = join(HERE, '..', 'test', 'fixtures', 'acceptance-probe')
/**
 * 带索引的测试项目，可用环境变量 `CODEGRAPH_TEST_PROJECT` 覆盖。
 * 默认值只对本仓库作者有意义的目录做探测，其他人跑验收时应指向自己带
 * `.codegraph/` 索引的项目。
 */
const INDEXED_PROJECT = process.env.CODEGRAPH_TEST_PROJECT ?? '.'
/** 这一份是插件仓库自身：没有索引。 */
const UNINDEXED_DIR = PLUGIN_DIR

const failures = []
const passes = []

function check(name, condition, detail) {
  if (condition) {
    passes.push(name)
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : `: ${detail}`}`)
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** 当前所有 codegraph 进程的 pid 集合（含 CodeGraph 自己的后台 daemon）。 */
function codegraphPids() {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*codegraph.js*' } | " +
    'Select-Object -ExpandProperty ProcessId'
  const child = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 60000 })
  return new Set(
    (child.stdout ?? '')
      .split(/\r?\n/u)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid)),
  )
}

/**
 * 运行结束后是否留下了本次运行新起的 codegraph 进程。
 *
 * 用「快照差集」而不是命令行特征：`codegraphArgs` 是开放数组，任何基于参数形状的
 * 规则（例如「命令行不含 --path 就是插件的」）都会在用户改动配置后失效，让这条
 * 断言假通过。差集只关心「运行前没有、运行后有的进程」，与参数内容无关，也天然
 * 排除用户自己早已启动的 daemon。
 */
function newProcessesSince(before) {
  return [...codegraphPids()].filter((pid) => !before.has(pid))
}

/** 进度日志：安装/还原 headless profile 时让人看得见发生了什么。 */
function log(message) {
  console.log(`[acceptance] ${message}`)
}

/** 经 cmd /c 跑一次 dsh CLI（Windows 不允许直接 spawn .cmd）。 */
function dsh(args, options = {}) {
  return spawnSync('cmd', ['/c', DSH_BIN, ...args], {
    encoding: 'utf8',
    timeout: 300000,
    windowsHide: true,
    ...options,
  })
}

/**
 * 把插件与探针临时装进 headless profile，返回还原函数。
 *
 * 验收需要真实 Host 装配，所以必须真正装进 profile；结束后无条件还原，避免污染
 * 用户环境。headless 是独立的 CLI profile，与 desktop 的会话互不影响。
 */
function prepareProfile() {
  log(`installing plugin + probe into the "${PROFILE}" profile`)
  for (const target of [PLUGIN_DIR, PROBE_DIR]) {
    const added = dsh(['plugin', '--profile', PROFILE, 'add', target])
    if (added.status !== 0) throw new Error(`failed to add ${target}: ${added.stderr || added.stdout}`)
  }
  return () => {
    log(`restoring the "${PROFILE}" profile`)
    for (const name of ['codegraph-acceptance-probe', 'dsh-codegraph-project']) {
      dsh(['plugin', '--profile', PROFILE, 'remove', name])
    }
  }
}

/**
 * 在指定目录启动一次 headless 运行，返回探针记录。
 *
 * 经 `cmd /c` 调用：Windows 上 Node 不允许 spawnSync 直接执行 `.cmd`（EINVAL），
 * 而 dsh 的 CLI 入口正是 `.cmd` 批处理。patch 只在本进程生效，不改 profile 状态。
 */
function observe(cwd, { config } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'codegraph-acceptance-'))
  const resultPath = join(workDir, 'result.json')
  try {
    const patchPath = join(workDir, 'overlay.yml')
    writeFileSync(patchPath, buildOverlay(config), 'utf8')
    // 主叠加层由 profile bundle 提供插件行；本叠加层只在需要时覆盖它的配置，
    // 顺序是「先探针、后覆盖」，保证覆盖落在这个 patch 层内生效。
    const patchArgs = config === undefined
      ? ['--patch', OVERLAY]
      : ['--patch', OVERLAY, '--patch', patchPath]
    const child = spawnSync(
      'cmd',
      ['/c', DSH_BIN, '--profile', PROFILE, ...patchArgs, '--json', 'hi'],
      {
        cwd,
        env: { ...process.env, DSH_CODEGRAPH_ACCEPTANCE_RESULT: resultPath },
        encoding: 'utf8',
        timeout: 180000,
        windowsHide: true,
      },
    )
    const steps = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')).steps : []
    return { steps, stdout: child.stdout ?? '', stderr: child.stderr ?? '' }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

/** 生成覆盖插件行配置的叠加层；`config` 省略时不覆盖。 */
function buildOverlay(config) {
  if (config === undefined) return ''
  const lines = ['- id: codegraph-project', '  name: dsh-codegraph-project', '  config:']
  for (const [key, value] of Object.entries(config)) lines.push(`    ${key}: ${JSON.stringify(value)}`)
  return `${lines.join('\n')}\n`
}

// 基线快照：运行前已存在的 codegraph 进程（含用户自己的后台 daemon）不算残留。
const baseline = codegraphPids()
console.log(`[acceptance] baseline codegraph pids: ${[...baseline].join(',') || '(none)'}`)

const restoreProfile = prepareProfile()
let exitCode = 0
try {
  console.log('\n1) 有索引的项目：会话能拿到 codegraph 工具')
  const indexed = observe(INDEXED_PROJECT)
  const indexedPreStep = indexed.steps.filter((step) => step.at === 'pre-step').at(-1)
  check(
    '有索引会话可见 mcp__codegraph__codegraph_explore',
    indexedPreStep?.tools?.includes('mcp__codegraph__codegraph_explore') === true,
    `tools=${JSON.stringify(indexedPreStep?.tools ?? [])}`,
  )
  const afterIndexed = indexedPreStep?.children ?? -1
  check('有索引会话期间确实起了插件托管的 codegraph 进程', afterIndexed >= 1, `children=${afterIndexed}`)

  // 提示词链路：这是「注入 instructions」功能的验收。不看插件内部状态，而是走
  // systemPrompt.assemble()——与 agent-loop 组装请求时同一条路径。
  const indexedSections = indexedPreStep?.prompt?.sections ?? []
  check(
    '有索引会话的系统提示词里存在 mcp:codegraph section',
    indexedSections.some((section) => section.name === 'mcp:codegraph'),
    `sections=${JSON.stringify(indexedSections.map((section) => section.name))}`,
  )
  const indexedPrompt = indexedSections.find((section) => section.name === 'mcp:codegraph')
  check(
    '注入的是 CodeGraph 官方 playbook（含特征标题）',
    indexedPrompt?.head?.includes('Codegraph — code intelligence') === true,
    `head=${JSON.stringify(indexedPrompt?.head ?? '')}`,
  )
  check(
    '注入体量接近上游全文（>6000 bytes，排除被截断）',
    (indexedPrompt?.bytes ?? 0) > 6000,
    `bytes=${indexedPrompt?.bytes ?? 0}`,
  )

  console.log('\n2) 无索引目录：会话里不存在 mcp__codegraph__* 工具')
  const unindexed = observe(UNINDEXED_DIR)
  const unindexedPreStep = unindexed.steps.filter((step) => step.at === 'pre-step').at(-1)
  check(
    '无索引会话没有任何 mcp__codegraph__* 工具',
    Array.isArray(unindexedPreStep?.tools) && unindexedPreStep.tools.length === 0,
    `tools=${JSON.stringify(unindexedPreStep?.tools ?? [])}`,
  )
  // 作用域正确性的关键断言：section 若挂成全局，这里就会出现 mcp:codegraph。
  // 工具「没注册」和提示词「没注入」必须同时成立，才算真的按会话隔离。
  const unindexedSections = unindexedPreStep?.prompt?.sections ?? []
  check(
    '无索引会话的系统提示词里没有 mcp:codegraph section（作用域隔离）',
    unindexedSections.length === 0,
    `sections=${JSON.stringify(unindexedSections.map((section) => section.name))}`,
  )

  console.log('\n3) harness 退出后无残留进程')
  await new Promise((resolve) => setTimeout(resolve, 800))
  const leaked = newProcessesSince(baseline)
  check('两次 headless 运行结束后没有残留插件进程', leaked.length === 0, `leaked pids=${leaked.join(',') || '(none)'}`)

  console.log('\n4) disabled: true 时行为与不挂载一致')
  const disabled = observe(INDEXED_PROJECT, { config: { enabled: false } })
  const disabledPreStep = disabled.steps.filter((step) => step.at === 'pre-step').at(-1)
  check(
    'disabled 会话没有 codegraph 工具',
    Array.isArray(disabledPreStep?.tools) && disabledPreStep.tools.length === 0,
    `tools=${JSON.stringify(disabledPreStep?.tools ?? [])}`,
  )
  check(
    'disabled 会话没有 mcp:codegraph section',
    (disabledPreStep?.prompt?.sections ?? []).length === 0,
    `sections=${JSON.stringify((disabledPreStep?.prompt?.sections ?? []).map((s) => s.name))}`,
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  const leakedDisabled = newProcessesSince(baseline)
  check('disabled 时不残留进程', leakedDisabled.length === 0, `leaked pids=${leakedDisabled.join(',') || '(none)'}`)

  console.log('\n5) injectInstructions: false 时只关提示词，工具照常')
  const noPrompt = observe(INDEXED_PROJECT, { config: { injectInstructions: false } })
  const noPromptPreStep = noPrompt.steps.filter((step) => step.at === 'pre-step').at(-1)
  check(
    'injectInstructions=false 时仍有 codegraph 工具',
    noPromptPreStep?.tools?.includes('mcp__codegraph__codegraph_explore') === true,
    `tools=${JSON.stringify(noPromptPreStep?.tools ?? [])}`,
  )
  check(
    'injectInstructions=false 时没有 mcp:codegraph section',
    (noPromptPreStep?.prompt?.sections ?? []).length === 0,
    `sections=${JSON.stringify((noPromptPreStep?.prompt?.sections ?? []).map((s) => s.name))}`,
  )

  console.log('\n6) maxInstructionBytes 过小时跳过注入，但工具照常')
  const tooSmall = observe(INDEXED_PROJECT, { config: { maxInstructionBytes: 10 } })
  const tooSmallPreStep = tooSmall.steps.filter((step) => step.at === 'pre-step').at(-1)
  check(
    'maxInstructionBytes=10 时工具照常可用',
    tooSmallPreStep?.tools?.includes('mcp__codegraph__codegraph_explore') === true,
    `tools=${JSON.stringify(tooSmallPreStep?.tools ?? [])}`,
  )
  check(
    'maxInstructionBytes=10 时跳过注入（不截断、不抛错）',
    (tooSmallPreStep?.prompt?.sections ?? []).length === 0,
    `sections=${JSON.stringify((tooSmallPreStep?.prompt?.sections ?? []).map((s) => s.name))}`,
  )

  console.log('\n7) 非法配置被 schema 拒绝，不会注册出畸形工具名')
  const conflict = observe(INDEXED_PROJECT, { config: { serverName: 'bad name!' } })
  const conflictPreStep = conflict.steps.filter((step) => step.at === 'pre-step').at(-1)
  check(
    '非法 serverName 不产生工具',
    Array.isArray(conflictPreStep?.tools) && conflictPreStep.tools.length === 0,
    `tools=${JSON.stringify(conflictPreStep?.tools ?? [])}`,
  )

  console.log('\n8) 配置了 --path 时进程判定仍然可靠（问题 4 的前提被破坏也能正确断言）')
  // codegraphArgs 是开放数组，用户可能加 --path。此时进程「是否残留」的判定若基于
  // 命令行特征就会失效；改用快照差集后，这里验证带 --path 的配置同样能被正确清理。
  const withPath = observe(INDEXED_PROJECT, {
    config: { codegraphArgs: ['serve', '--mcp', '--path', INDEXED_PROJECT] },
  })
  const withPathPreStep = withPath.steps.filter((step) => step.at === 'pre-step').at(-1)
  check(
    '带 --path 的配置也能挂载工具',
    withPathPreStep?.tools?.includes('mcp__codegraph__codegraph_explore') === true,
    `tools=${JSON.stringify(withPathPreStep?.tools ?? [])}`,
  )
  await new Promise((resolve) => setTimeout(resolve, 800))
  const leakedWithPath = newProcessesSince(baseline)
  check('带 --path 的配置退出后也无残留', leakedWithPath.length === 0, `leaked pids=${leakedWithPath.join(',') || '(none)'}`)
} finally {
  restoreProfile()
}

if (failures.length > 0) {
  console.error(`\n[acceptance] FAILED ${failures.length} check(s):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  exitCode = 1
} else {
  console.log(`\n[acceptance] OK: ${passes.length} checks passed`)
}
process.exitCode = exitCode
