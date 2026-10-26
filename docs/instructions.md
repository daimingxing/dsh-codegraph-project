# 注入 CodeGraph 的 `instructions`

## 决定

插件把 CodeGraph 在 MCP `initialize` 响应里返回的 `instructions` 注入系统提示词，默认开启。

这份文档替换了此前那篇 `why-no-prompt.md`（「不注入的理由」）。那篇的结论是错的，
下面第 4 节记录了它错在哪里，以及为什么那个错误在当时是「合理但不可验证」的。

## 背景：这条通道原本存在

MCP 协议规定服务端可以在 `initialize` 响应里返回 `instructions` 字段，客户端负责把它
呈现给模型。DSH 官方 `@deepseek-ai/dsh-mcp-client` 实现了这一步
（`registerServerContext` → `systemPrompt.section({ name: 'mcp:<server>', order: MCP_SERVERS })`）。

CodeGraph 把整篇 playbook 放在这个字段里，并**因此**把 installer 写进 `AGENTS.md` 的块
刻意写薄。上游 `installer/instructions-template.js` 的注释说明了这个历史：

> pre-#529 the installer wrote a full usage playbook here, which duplicated the MCP
> `initialize` instructions for the main agent — so it was removed and
> `mcp/server-instructions.ts` became the **single source of truth**. A much smaller
> block returned for #704 …

也就是说：**`AGENTS.md` 里那段 10 行是设计上就残缺的**，它只负责覆盖两类拿不到
MCP instructions 的受众——task-tool 子代理、非 MCP 宿主（只能跑 CLI）。

本插件自建 transport，不走 `dsh-mcp-client`，于是这条注入链路整条断开。结果主 agent
既没拿到 playbook，`AGENTS.md` 的块又按「已经有人覆盖了」而写薄——两头落空。

## 实测数据

用 `node scripts/probe-instructions.mjs <项目>` 直接对真实项目起子进程读握手响应：

| 项目 | serverInfo | instructions | 含 `{{` |
|---|---|---|---|
| `D:\WorkPlace\open-code-review` | codegraph 1.6.2 | **6786 bytes** | 否 |
| `D:\WorkPlace\dunde-Project\2DGIS-project\2dgis-f` | codegraph 1.6.2 | **6786 bytes** | 否 |

两处都返回完整 playbook（`# Codegraph — code intelligence over an indexed knowledge
graph`）。约 1.7k token，每次请求都会带上。

不含 `{{` 这一点是**安全相关**的：DSH 的提示词插值遇到非法或未知的 `{{name}}` 会抛错，
抛在 `assemble()` 里就会让整个请求失败。当前上游文案安全，但它是外部输入、会随版本变化，
所以插件用 `interpolate: false` 把它钉成字面量（见下文）。

## 实现：三个位置，各负责一件事

```
transport.start()   →  捕获 initialize.instructions（唯一协议入口）
      ↓
ProjectHub          →  持有，instructions() 访问器（同项目多会话共享一份）
      ↓
mount(agent, hub)   →  注册 per-agent systemPrompt section（跟着项目走）
```

### 为什么注册在 `agent.ctx` 而不是顶层 `ctx`

这是与官方 `dsh-mcp-client` 的**必要差异**：

| | dsh-mcp-client | 本插件 |
|---|---|---|
| 服务端配置 | profile 级、全局唯一 | 每个会话可能在不同项目 |
| 注册位置 | 顶层 ctx（全局 section） | **`agent.ctx`（per-agent 层）** |
| 卸载时机 | 插件卸载 | 换项目 / 索引消失时立即卸 |

`dsh-system-prompt` 的 `ScopedLayers` 语义支持这个用法：`merge(scope)` 时 scoped 层按名字
**遮蔽** global 层，只有同一层内重名才抛错。所以 per-agent 注册既能做到「跟着项目走」，
也不会和用户真配了同名 `serverName` 的 mcp-client 行冲突。

附带收益：**子代理也走 `agent/created`**，因此自动获得指引——这正是 `AGENTS.md` 文件块
覆盖不到的那类受众。

### 一个必须记住的坑：服务要从 `agent.ctx` 取

```js
const systemPrompt = agent.ctx.get('systemPrompt')   // 对
const systemPrompt = ctx.get('systemPrompt')         // 错：会挂成全局 section
```

Cordis 的 `get()` 返回绑定到**调用方 ctx** 的 traceable 服务
（`createTraceable` 的 `symbols.shadow` 重绑定），`section()` 再据此决定注册进哪个
scoped 层。用插件自己的 `ctx` 取，section 就落到全局层——于是**无索引的会话也会看到
codegraph 指引**。这个错误不会报错、不会告警，只会表现为「提示词里多了一段不该有的东西」。

真机验收里有一条专门守这个：无索引目录的会话必须**既没有工具、也没有 section**。

### `interpolate: false` 不是可选项

DSH 的 `interpolate()` 遇到未知/非法 `{{name}}` 会抛错，抛在 `assemble()` 里会让整个请求
失败。`interpolate: false` 把上游文本当字面量，代价为零，收益是把「上游改文案」从
「插件让整个会话不可用」降级为「文案原样显示」。

## 降级策略：绝不影响工具

| 情况 | 行为 |
|---|---|
| `initialize` 无 `instructions` | 不注册 section，工具照常 |
| 超过 `maxInstructionBytes` | **跳过并 warn 一次**，不截断、不抛错 |
| `systemPrompt` 服务不存在（headless/minimal profile） | 跳过并 debug 日志 |
| section 注册抛错（同名冲突） | warn 后继续注册工具 |
| `injectInstructions: false` | 完全不注册 |

**与官方的一处有意分歧**：`dsh-mcp-client` 在超限时 `throw`，导致整条连接失败。
本插件不照抄——指引是顾问性的，工具才是功能本体。让 1.7k token 的文案把查询能力搞挂，
是错的优先级。

## 配置

```yaml
- id: codegraph-project
  name: dsh-codegraph-project
  config:
    injectInstructions: true      # 默认 true
    maxInstructionBytes: 32768    # 默认与 DSH mcp-client 同值
```

默认开启的理由：这不是「增强」，是把官方设计补齐。关掉它的唯一合理理由是省 token。

## 上一版文档错在哪里

`why-no-prompt.md` 的核心论证是「工具 description 已经覆盖核心指引，那 6.7KB 只是进阶
用法」。这条论证有两个问题：

1. **description 确实覆盖了「怎么用」，但没覆盖「什么时候会误判」。** playbook 里恰好有
   我们踩坑后才「重新发现」的东西：
   - `Explore matches names and indexed code words lexically, not by meaning`（解释了
     `postMessage` 为什么会命中 `system/post`）
   - 索引新鲜度 banner 的三种语义
   - `Trust codegraph's results — don't re-verify them with grep`

   把「进阶用法」判为可省，等于让模型每次都重新踩一遍同样的坑。

2. **它把「项目级提示词的正确位置是 AGENTS.md」当成了普遍结论。** 这个结论在
   「MCP instructions 能到达」的前提下才成立；在本插件的组合下前提不成立，于是它变成了
   一个自我实现的错误——因为相信 AGENTS.md 够用，所以不注入；因为不注入，所以只能靠
   AGENTS.md。

第 2 点在当时难以证伪，因为验证它需要读完上游 CLI 的编译产物并做对照实验。这也是为什么
这个决定值得写进文档：**下一个读到它的人应该能直接看到前提，而不是重走一遍。**

## 仍需项目自己处理的部分

修好这条通道**不会**解决「`postMessage` 命中 `system/post`」这类问题。playbook 只说明
「词法匹配、空结果会给候选名」，没有说「避免 `data`/`list`/`type`/`post` 这类通用 token」。
那是项目词汇表与 RuoYi 脚手架碰撞，属于**项目级**问题，正确落点仍是项目自己的
`AGENTS.md` 加一行使用约定。建议在 A 生效后实测再决定要不要加，而不是预先堆规则。
