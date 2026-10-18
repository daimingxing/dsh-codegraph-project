/**
 * 会话工作目录 → CodeGraph 项目根。
 *
 * 纯函数式探测，不缓存、不产生副作用：调用方（index.js）在会话创建、以及无索引
 * 会话的每次 pre-step 里重新调用，以便接住会话中途执行的 `codegraph init`。
 *
 * 返回四种状态，调用方只需区分「可服务 / 不可服务」：
 *   { state: 'indexed',       projectRoot, stopReason: 'index' }
 *   { state: 'missing',       stopReason: 'git-root' | 'filesystem-root' }
 *   { state: 'not-a-project', stopReason: 'empty-index' | 'home-directory' | 'index-unreadable', indexRoot? }
 *   { state: 'no-cwd' }
 *
 * 关键约束见下面对应的分支注释；四条规则都不能省，否则会静默服务错误的代码库。
 */

import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'

/** CodeGraph 在项目根下放置索引与运行时状态的目录名。 */
const INDEX_DIR = '.codegraph'
/** 索引数据库的扩展名；`daemon.pid` / `daemon.log` / `writer.pid` 都不匹配。 */
const DB_SUFFIX = '.db'

/**
 * 探测一个路径自身的条目状态。
 * 之所以不用 `existsSync`：它把 EACCES 之类的失败一并吞成「不存在」，会让
 * `.codegraph` 读不了时静默继续向上遍历，正好是我们要避免的行为。
 *
 * @returns {{ kind: 'absent' } | { kind: 'denied', error: Error } | { kind: 'present', isDirectory: boolean }}
 */
function probe(path) {
  try {
    return { kind: 'present', isDirectory: statSync(path).isDirectory() }
  } catch (error) {
    // ENOTDIR：路径中间某一级是文件，等价于「这个位置没有该条目」。
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { kind: 'absent' }
    return { kind: 'denied', error }
  }
}

/** 路径比较：Windows 大小写不敏感，POSIX 敏感；两侧都先规范化。 */
function samePath(left, right) {
  const normalize = (value) => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value))
  return normalize(left) === normalize(right)
}

/** 文件系统根（`D:\`、`/`）不可能是项目根；`boundary` 是测试注入的人造根。 */
function isFilesystemRoot(path, boundary) {
  return parse(path).root === path || (boundary !== undefined && samePath(path, boundary))
}

/**
 * 家目录与根不算项目根。
 *
 * 否则 `~/.codegraph/codegraph.db`（CodeGraph 的全局库位置）会让 `$HOME` 下的
 * 每个会话都认领整个家目录，查询结果毫无意义。
 */
function isHomeOrRoot(path, home) {
  return isFilesystemRoot(path) || samePath(path, home)
}

/** 目录里是否存在索引数据库。 */
function hasDatabase(indexRoot) {
  return readdirSync(indexRoot).some((name) => name.toLowerCase().endsWith(DB_SUFFIX))
}

/**
 * 从 `cwd` 向上逐层查找 CodeGraph 索引。
 *
 * @param {string | undefined} cwd 会话连接的工作目录（SessionHeader.cwd）。
 * @param {{ home?: string, boundary?: string }} [options]
 *   仅用于测试注入：`home` 覆盖家目录判断，`boundary` 模拟文件系统根，
 *   避免测试依赖于真实磁盘上层的目录内容。
 * @returns {object} 见模块头的四种状态。
 */
export function locateIndex(cwd, options = {}) {
  if (typeof cwd !== 'string' || cwd === '') return { state: 'no-cwd' }
  const home = options.home ?? homedir()
  const boundary = options.boundary

  let current = resolve(cwd)
  for (;;) {
    const indexRoot = join(current, INDEX_DIR)
    const indexProbe = probe(indexRoot)

    // `.codegraph` 本身读不了就停：继续向上会把一次权限问题变成「服务了错误的代码库」。
    if (indexProbe.kind === 'denied') {
      return { state: 'not-a-project', stopReason: 'index-unreadable', indexRoot }
    }
    // 同名普通文件不是索引目录，同样不再向上找。
    if (indexProbe.kind === 'present' && !indexProbe.isDirectory) {
      return { state: 'not-a-project', stopReason: 'index-unreadable', indexRoot }
    }

    if (indexProbe.kind === 'present') {
      let entries
      try {
        entries = hasDatabase(indexRoot)
      } catch {
        return { state: 'not-a-project', stopReason: 'index-unreadable', indexRoot }
      }
      // 只有 daemon.pid / daemon.log / writer.pid 的目录不是项目。
      if (!entries) return { state: 'not-a-project', stopReason: 'empty-index', indexRoot }
      if (isHomeOrRoot(current, home)) {
        return { state: 'not-a-project', stopReason: 'home-directory', indexRoot }
      }
      return { state: 'indexed', projectRoot: current, stopReason: 'index' }
    }

    // 索引落在仓库边界之上时属于别的仓库，不能认领。
    // `.git` 读不了时按存在处理：停下来总比向上误认领安全。
    const gitProbe = probe(join(current, '.git'))
    if (gitProbe.kind !== 'absent') return { state: 'missing', stopReason: 'git-root' }

    if (isFilesystemRoot(current, boundary)) return { state: 'missing', stopReason: 'filesystem-root' }
    const parent = dirname(current)
    if (parent === current) return { state: 'missing', stopReason: 'filesystem-root' }
    current = parent
  }
}
