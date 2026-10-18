import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { locateIndex } from '../lib/locate.js'

/** 建一棵临时目录树；返回根路径，测试结束时删除。 */
function makeTree(t, shape) {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-locate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
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

test('正常索引：在 cwd 自身命中', (t) => {
  const root = makeTree(t, {
    'project/.codegraph/codegraph.db': '',
    'project/src/main.js': '',
  })
  const cwd = join(root, 'project', 'src')

  const result = locateIndex(cwd, { home: join(root, 'home') })

  assert.equal(result.state, 'indexed')
  assert.equal(result.projectRoot, join(root, 'project'))
  assert.equal(result.stopReason, 'index')
})

test('只有 daemon.pid 的 .codegraph 不算项目，且不再向上', (t) => {
  const root = makeTree(t, {
    '.codegraph/codegraph.db': '',
    'project/.codegraph/daemon.pid': '1234',
    'project/.codegraph/daemon.log': '',
    'project/.codegraph/writer.pid': '5678',
  })
  const cwd = join(root, 'project', 'src')

  const result = locateIndex(cwd, { home: join(root, 'home') })

  assert.equal(result.state, 'not-a-project')
  assert.equal(result.stopReason, 'empty-index')
  assert.equal(result.indexRoot, join(root, 'project', '.codegraph'))
})

test('家目录上的索引不被认领', (t) => {
  const root = makeTree(t, {
    'home/.codegraph/codegraph.db': '',
    'home/work/readme.md': '',
  })
  const home = join(root, 'home')

  const result = locateIndex(join(home, 'work'), { home })

  assert.equal(result.state, 'not-a-project')
  assert.equal(result.stopReason, 'home-directory')
  assert.equal(result.indexRoot, join(home, '.codegraph'))
})

test('遇到 .git 就停，索引在仓库边界之上不被认领', (t) => {
  const root = makeTree(t, {
    '.codegraph/codegraph.db': '',
    'repo/.git/HEAD': 'ref: refs/heads/main\n',
    'repo/src/main.js': '',
  })
  const cwd = join(root, 'repo', 'src')

  const result = locateIndex(cwd, { home: join(root, 'home') })

  assert.equal(result.state, 'missing')
  assert.equal(result.stopReason, 'git-root')
})

test('.codegraph 读不了就停，不向上认领', (t) => {
  const root = makeTree(t, {
    '.codegraph/codegraph.db': '',
    'locked/src/main.js': '',
  })
  const lockedIndex = join(root, 'locked', '.codegraph')
  // 用一个同名普通文件制造「读不了」：stat 得到的是文件，遍历内容必然失败。
  writeFileSync(lockedIndex, 'not a directory')

  const result = locateIndex(join(root, 'locked', 'src'), { home: join(root, 'home') })

  assert.equal(result.state, 'not-a-project')
  assert.equal(result.stopReason, 'index-unreadable')
  assert.equal(result.indexRoot, lockedIndex)
})

test('一路向上到文件系统根仍未命中', (t) => {
  const root = makeTree(t, { 'plain/readme.md': '', 'home/notes.md': '' })

  // 真实磁盘的上层目录内容不可控（本机家目录就带一个空的 ~/.codegraph），
  // 所以用 boundary 把 tmp 目录声明成文件系统根。
  const result = locateIndex(join(root, 'plain'), { home: join(root, 'home'), boundary: root })

  assert.equal(result.state, 'missing')
  assert.equal(result.stopReason, 'filesystem-root')
})

test('没有 cwd', () => {
  assert.deepEqual(locateIndex(undefined), { state: 'no-cwd' })
  assert.deepEqual(locateIndex(''), { state: 'no-cwd' })
})
