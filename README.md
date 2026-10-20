<div align="center">

# dsh-codegraph-project

**让 DeepSeek Harness 的每个会话，只查它自己所在仓库的 CodeGraph 索引。**

[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-plugin-5ad1c4)](https://github.com/deepseek-ai/deepseek-harness)
[![CodeGraph](https://img.shields.io/badge/CodeGraph-1.6.2%20verified-f0a75a)](https://github.com/colbymchenry/codegraph)
[![Tests](https://img.shields.io/badge/tests-27%20passing-6bc46d)](#验证)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)

</div>

---

**这是一个 CodeGraph 兼容层，不是又一个 CodeGraph。**

插件不重新实现任何索引、查询或代码分析逻辑——它直接复用你已经安装的 CodeGraph CLI 和它建好的 `.codegraph/` 索引，把工具按**项目维度**接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。因此：

- CodeGraph 升级、换版本、重建索引，本插件照常工作；
- Codex、Claude Code、Cursor 等工具的 CodeGraph 配置**原样保留**，互不影响——本插件不写任何全局配置文件，不抢注任何 MCP 服务名；
- 卸载本插件，你的 CodeGraph 环境和你其他工具的集成完全不受影响。

接入后，DSH 里的每个会话根据自己的工作目录自动定位 `.codegraph/` 索引，多项目各用各的连接，互不串味。

## 传统接法的问题：一个 cwd，多个仓库

把 CodeGraph 接进任何宿主（包括 DSH），官方姿势都是配一个 MCP 服务、指向一个项目目录。这在单仓库下没有问题，但 DSH 的插件配置是 **profile 级（全局）**——你只有一个配置位，却可能同时开着五六个仓库的会话：

```yaml
- insert:
    - id: mcp-codegraph
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        cwd: D:\path\to\only-one-project     # ← 换个项目就错了
```

后果不是报错，而是更糟的**静默查错仓库**——你在仓库 B 的会话里提问，它返回仓库 A 的结果。会话看起来一切正常，答案却是另一个代码库的，直到某天你发现它引用了一个根本不存在的类。

本插件解决的问题就一句话：**让"当前项目"由会话自己决定，而不是由一份全局配置决定。**

## 解法：把"项目"补在 DSH 侧

```
agent A（仓库甲的会话）── mcp__codegraph__codegraph_explore ──→ ProjectHub(甲) ──→ codegraph 进程 #1
agent B（仓库甲的会话）── mcp__codegraph__codegraph_explore ──→ （共享 #1）
agent C（仓库乙的会话）── mcp__codegraph__codegraph_explore ──→ ProjectHub(乙) ──→ codegraph 进程 #2
agent D（无索引目录）  ──（看不到任何 codegraph 工具）
```

三条核心机制：

1. **工具注册在会话 scope 上** —— `agent.ctx.tools.register()`。无索引的会话根本看不到工具，不需要运行时拒绝。
2. **每个项目一个子进程** —— 进程 `cwd` 就是项目根，查询不需要额外参数；同项目的多个会话共享一个进程（引用计数，归零才关）。
3. **子进程走 `ctx.subprocess`** —— 由 DSH 托管，插件停用或 harness 退出时进程一定被回收。

挂载由一个会话级 `agent/pre-step` 监听器持续对齐，因此同时覆盖：会话中途 `codegraph init`（下一条消息即可用）、中途 `cd` 到另一个仓库（工具跟随切换）、索引被删除（工具消失）。

## 安装

**前置条件**

- DeepSeek Harness（`0.2.1-rc.2` 已验证）
- [CodeGraph CLI](https://github.com/colbymchenry/codegraph) 已全局安装（`codegraph` 在 PATH 上，或配置 `codegraphBin`）
- 目标项目执行过 `codegraph init`

**两种安装方式**

```bash
# 方式一：从 npm 安装（推荐，装完即用）
dsh plugin --profile <你的 profile> add dsh-codegraph-project

# 方式二：本地目录（开发/自用）
# 在 DSH 的 Plugins 页粘贴本仓库的绝对路径，或用 CLI：
dsh plugin --profile <你的 profile> add <本仓库路径>
```

> **依赖说明**：`@deepseek-ai/schemastery` 声明为宿主共享的 `peerDependencies`；
> 使用 npm 7 及以上版本安装时，会自动补齐缺失的 peer 依赖。本地目录安装时，
> 由于 ESM 从源码目录解析依赖，需要先在仓库里执行一次 `npm install --omit=dev`。

包已发布：[npmjs.com/package/dsh-codegraph-project](https://www.npmjs.com/package/dsh-codegraph-project) ·
当前版本见 `npm view dsh-codegraph-project version`。

安装后**零配置**：有索引的会话自动获得工具，没有的会话干净如初。

## 配置

所有配置都有默认值，通常不需要动。在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: codegraph-project
  config:
    serverName: codegraph        # 工具命名空间
    toolCallTimeoutMs: 60000     # 单次调用超时
    watchIntervalMs: 2000        # 无索引会话的重探间隔
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时不注册工具、不起进程 |
| `serverName` | `codegraph` | 公开工具名为 `mcp__<serverName>__<tool>` |
| `codegraphBin` | `''` | 可执行文件绝对路径；留空从 PATH 探测 |
| `codegraphArgs` | `['serve', '--mcp']` | 配合 `codegraphBin` 的参数 |
| `toolCallTimeoutMs` | `60000` | 单次工具调用超时（必须为正数） |
| `connectTimeoutMs` | `5000` | MCP 握手超时 |
| `watchIntervalMs` | `2000` | 无索引会话的重新探测间隔，`0` 表示每条消息都探测 |

**Windows 的 `.cmd` 坑**：npm 全局安装的 `codegraph` 是 `.cmd` 批处理，不能直接
spawn。插件会自动从 npm 全局布局推导 `node.exe` + 入口脚本；推导失败时错误信息里
给出可直接粘贴的 `codegraphBin` / `codegraphArgs` 配置。

## 认领规则：什么时候一个目录算"项目"

会话目录向上逐层查找 `.codegraph/`，四条边界规则防止"静默服务错误仓库"：

| 规则 | 原因 |
|---|---|
| `.codegraph/` 里必须有 `*.db` | 只有 `daemon.pid` / `daemon.log` 的目录不是项目 |
| 遇到 `.git` 就停 | 索引在仓库边界之上属于别的仓库 |
| 家目录 / 文件系统根不算 | 否则 `~/.codegraph/` 会让 `$HOME` 下所有会话认领它 |
| `.codegraph` 读不了就停 | 继续向上会把权限问题变成查错仓库 |

## 验证

```bash
npm install --omit=dev        # 先装依赖（见上）

node --test test/locate.test.js test/pool.test.js test/bridge.test.js   # 27 个单元测试
node scripts/check-locate.mjs                                           # 认领规则 + 真机抽查
node scripts/check-sharing.mjs <有索引的项目目录>                        # 同项目共享一个进程
node scripts/check-failure-reporting.mjs                               # 启动失败的去重上报
node scripts/probe.mjs <有索引的项目目录> <查询词>                        # 真实 CodeGraph 端到端
node scripts/acceptance.mjs                                            # 真机验收（headless）
```

部分脚本接受环境变量指定本机测试项目：

| 变量 | 用于 | 默认 |
|---|---|---|
| `CODEGRAPH_TEST_PROJECT` | `check-sharing.mjs`、`acceptance.mjs` | `.` |
| `CODEGRAPH_TEST_PROJECTS` | `check-locate.mjs`（逗号分隔多个） | 跳过真机抽查 |
| `DSH_BIN` | `acceptance.mjs`（dsh CLI 路径） | Windows 默认安装位置 |

`acceptance.mjs` 会临时把插件与探针装进 `headless` profile、跑完自动还原；它验证
Host 内部可观察状态（会话可见工具、进程事实），不跑模型轮次。

## 诊断

DSH 的 `SubprocessHandle` 不暴露 pid，插件改用**项目标识**对应进程与日志：

- 每个 codegraph 子进程带环境变量 `DSH_CODEGRAPH_PROJECT=<项目根>`，按环境变量反查进程即可；
- `ProjectHub.projectTag` / `ProjectHub.stderrTail` 暴露同一标识与子进程 stderr 尾部；
- 会话销毁时按 debug 级记录释放结果与剩余会话数；
- 启动失败在同一项目上只告警一次，恢复后复发会再次告警。

## 更新

已通过 npm 安装后，升级到新版本：

```bash
dsh plugin --profile <你的 profile> add dsh-codegraph-project   # 重新 add 即升级到 latest
```

维护者发布新版本：

```bash
# 改代码 → 测试 → 提交（npm version 要求工作区干净）
npm test
git add -A && git commit -m "..."

# 升版本号（同时改 package.json + 自动 commit + 打 tag）
npm version patch   # 修 bug：0.1.0 → 0.1.1
npm version minor   # 新功能：0.1.0 → 0.2.0
npm version major   # 破坏性变更：0.1.0 → 1.0.0

git push && git push --tags
npm publish --registry=https://registry.npmjs.org
```

版本号遵循 [semver](https://semver.org/lang/zh-CN/)：已发布的版本号永不复用，改动再小也发新版本号。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/implementation-plan.md](docs/implementation-plan.md) | 开发指南：架构、逐模块实现、实施顺序、验收清单 |
| [docs/architecture.md](docs/architecture.md) | 7 个关键设计决策与被否决的替代方案 |
| [docs/technical-findings.md](docs/technical-findings.md) | 12 项 DSH 源码调研与运行时验证记录 |
| [docs/risks.md](docs/risks.md) | 13 项风险与边界条件 |
| [docs/why-no-prompt.md](docs/why-no-prompt.md) | 为什么不注入提示词 |

## 与 troytse/dsh-plugin-codegraph-project 的差异

参考过 [troytse/dsh-plugin-codegraph-project](https://github.com/troytse/dsh-plugin-codegraph-project)（MIT），设计取舍不同：

| 能力 | 它 | 本插件 |
|---|---|---|
| CodeGraph 来源 | npx 拉取 + 版本管理 | 用系统已安装的 |
| 工具注册 | 全局 + guard + 路由 | 按会话 scope |
| 索引发现 | 250 行轮询 | `agent/pre-step` 懒检测 |
| 提示词 | 注入 usage guidance | 不注入 |
| 规模 | ~2900 行 | ~960 行 |

## License

MIT
