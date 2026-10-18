/**
 * 逐个验证 locate.js 的认领边界规则。
 *
 * 这些规则错了不会报错，只会静默服务错误的代码库，所以单独跑一个可复现的脚本：
 * 用真实临时目录 + 真实 `.codegraph/` 结构，打印每个场景的判定。
 *
 * 用法：node scripts/check-locate.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { locateIndex } from '../lib/locate.js'

const failures = []
let passes = 0

function expect(name, actual, expected) {
  const ok = actual.state === expected.state
    && (expected.stopReason === undefined || actual.stopReason === expected.stopReason)
    && (expected.projectRoot === undefined || actual.projectRoot === expected.projectRoot)
  if (ok) {
    passes += 1
    console.log(`  PASS  ${name} → ${actual.state}/${actual.stopReason ?? '-'}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}\n         actual=${JSON.stringify(actual)}\n         expect=${JSON.stringify(expected)}`)
  }
}

/** 造一棵临时目录树；值为 null 表示目录，否则写文件。 */
function makeTree(shape) {
  const root = mkdtempSync(join(tmpdir(), 'cg-locate-'))
  for (const [relative, content] of Object.entries(shape)) {
    const target = join(root, relative)
    if (content === null) {
      mkdirSync(target, { recursive: true })
    } else {
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, content)
    }
  }
  return root
}

const home = join(homedir(), 'codegraph-locate-home-fixture')
const roots = []

console.log('1) 正常索引：在仓库根命中')
{
  const root = makeTree({ 'repo/.codegraph/codegraph.db': '', 'repo/src/a.js': '' })
  roots.push(root)
  expect('嵌套子目录向上找到仓库根', locateIndex(join(root, 'repo', 'src'), { home }), {
    state: 'indexed',
    projectRoot: join(root, 'repo'),
  })
}

console.log('\n2) 只有 daemon.pid / daemon.log / writer.pid 的 .codegraph 不算项目')
{
  const root = makeTree({
    '.codegraph/codegraph.db': '',
    'p/.codegraph/daemon.pid': '1',
    'p/.codegraph/daemon.log': '',
    'p/.codegraph/writer.pid': '2',
    'p/src/a.js': '',
  })
  roots.push(root)
  expect('空索引目录停止且不向上认领', locateIndex(join(root, 'p', 'src'), { home }), {
    state: 'not-a-project',
    stopReason: 'empty-index',
  })
}

console.log('\n3) 家目录上的索引不被认领')
{
  const root = makeTree({ 'home/.codegraph/codegraph.db': '', 'home/work/a.txt': '' })
  roots.push(root)
  expect('家目录索引被拒绝', locateIndex(join(root, 'home', 'work'), { home: join(root, 'home') }), {
    state: 'not-a-project',
    stopReason: 'home-directory',
  })
}

console.log('\n4) 遇到 .git 就停，仓库边界之上的索引不被认领')
{
  const root = makeTree({
    '.codegraph/codegraph.db': '',
    'repo/.git/HEAD': 'ref: refs/heads/main\n',
    'repo/src/a.js': '',
  })
  roots.push(root)
  expect('git 边界阻止向上认领', locateIndex(join(root, 'repo', 'src'), { home }), {
    state: 'missing',
    stopReason: 'git-root',
  })
}

console.log('\n5) .codegraph 读不了就停')
{
  const root = makeTree({ '.codegraph/codegraph.db': '', 'locked/src/a.js': '' })
  roots.push(root)
  // 用同名普通文件制造"不是目录、读不了内容"的情形。
  writeFileSync(join(root, 'locked', '.codegraph'), 'not a directory')
  expect('不可读索引停止且不向上认领', locateIndex(join(root, 'locked', 'src'), { home }), {
    state: 'not-a-project',
    stopReason: 'index-unreadable',
  })
}

console.log('\n6) 真机目录抽查')
// 用环境变量指定本机实际有索引的项目；没设置时跳过抽查（单测与上面的临时目录
// 场景已覆盖全部规则，这一节只是对本机环境做冒烟）。
const realProjects = (process.env.CODEGRAPH_TEST_PROJECTS ?? '')
  .split(/[,;]/u)
  .map((path) => path.trim())
  .filter((path) => path !== '')
for (const project of realProjects) {
  const location = locateIndex(project)
  expect(`${project} 被认领为项目根`, location, { state: 'indexed', projectRoot: project })
}
// 仓库边界之上的例子：本插件仓库自身无索引，不应被认领。
expect('本插件仓库（无索引）不被认领', locateIndex(process.cwd()), { state: 'missing' })

for (const root of roots) rmSync(root, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n[locate] FAILED ${failures.length} check(s):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log(`\n[locate] OK: ${passes} checks passed`)
}
