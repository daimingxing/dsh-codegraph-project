/**
 * 插件行配置 schema。
 *
 * 配置是 profile 级的，同一份配置服务所有项目：真正区分项目的信息来自会话工作
 * 目录，不在这里。因此这里只有进程启动方式、命名空间与几个超时。
 */

import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  /** 总开关；关闭后不注册任何工具，也不启动子进程。 */
  enabled: z.boolean().default(true),
  /** 工具命名空间，公开名为 `mcp__<serverName>__<tool>`；与内置 MCP 客户端保持同一约定。 */
  serverName: z.string().pattern(/^[A-Za-z0-9_-]{1,32}$/).default('codegraph'),
  /** 可执行文件绝对路径；留空则从 PATH 探测。Windows 上需指向 node.exe，见 transport/resolveArgv。 */
  codegraphBin: z.string().default(''),
  /** 配合 codegraphBin 的参数；默认即 `codegraph serve --mcp`。 */
  codegraphArgs: z.array(String).default(['serve', '--mcp']),
  /**
   * 单次工具调用超时。必须为正数：tools.register() 会校验 timeoutMs，
   * 配成 0 或负数直接抛 TypeError，插件整行加载失败。
   */
  toolCallTimeoutMs: z.number().min(1).default(60000),
  /** MCP 握手超时。 */
  connectTimeoutMs: z.number().min(1).default(5000),
  /** 无索引会话的重新探测间隔；0 表示每条消息都探测。 */
  watchIntervalMs: z.number().min(0).default(2000),
  /**
   * 是否把 CodeGraph 在 MCP `initialize` 里给出的使用指引注入系统提示词。
   *
   * 默认开启：这不是「增强」，而是补齐 DSH 官方 mcp-client 本来就会做的一步。
   * 上游把完整 playbook 放在这里，并因此把 installer 写进 AGENTS.md 的块刻意
   * 写薄；自建 transport 不补这一步，两处指引就会同时缺位。
   *
   * 关掉它的唯一合理理由是省 token：实测 CodeGraph 1.6.2 的指引为 6786 字节
   * （约 1.7k token），每次请求都会带上。
   */
  injectInstructions: z.boolean().default(true),
  /**
   * 注入的指引字节上限（UTF-8），与 DSH `mcp-client` 的同名配置取同一默认值。
   *
   * 超限时的行为与官方**不同**：官方抛错让整条连接失败，这里只跳过注入并告警。
   * 理由是优先级——指引是顾问性的，工具才是功能本体，不该让一段文案把查询能力
   * 搞挂。
   */
  maxInstructionBytes: z.number().step(1).min(1).default(32768),
})
