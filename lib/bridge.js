/**
 * MCP 工具定义 → DSH 工具定义。
 *
 * 两处平台细节与"直觉写法"不同，都以本机 DSH 0.2.1-rc.2 的实际实现为准确认过
 * （参考同版本 @deepseek-ai/dsh-mcp-client 的桥接做法）：
 *
 * 1. `parameters` 直接用 MCP 的 inputSchema。原因是这里走的是 `ctx.tools.register()`
 *    的原始定义路径，注册表把它原样投影给模型（见 dsh-tools `schemaOf`）；只有
 *    `defineTool()` 才会把 `parameters` 当作"属性 map"再编译成 JSON Schema。
 * 2. `output.schema` 必须是 DSH 支持的 JSON Schema 子集（type/oneOf/properties/
 *    required/additionalProperties/items/enum/const + 注解）。该子集没有 `json`
 *    类型，所以"任意 JSON"位置用空 schema `{}` 表示，不能用 `{ type: 'json' }`。
 */

/**
 * 把上游 inputSchema 收敛到 DSH/模型都能接受的 JSON Schema 子集。
 *
 * CodeGraph 1.6.2 实测只有 string/number + enum + default，但上游升级后可能引入
 * `$ref`、`oneOf` 之外的关键字。这里做保守降级：不认识的关键字丢弃，认不出的类型
 * 退化成"任意值"空 schema，保证一个怪 schema 不会让整行插件注册失败。
 *
 * @param {unknown} inputSchema MCP tools/list 返回的 inputSchema
 * @returns {{ type: 'object', properties: object, required?: string[], additionalProperties?: boolean }}
 */
export function toToolParameters(inputSchema) {
  const schema = isRecord(inputSchema) ? inputSchema : {}
  const rawProperties = isRecord(schema.properties) ? schema.properties : {}
  const properties = {}
  for (const [name, spec] of Object.entries(rawProperties)) {
    properties[name] = normalizeProperty(spec)
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name) => typeof name === 'string' && Object.hasOwn(properties, name))
    : []
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(typeof schema.additionalProperties === 'boolean'
      ? { additionalProperties: schema.additionalProperties }
      : {}),
  }
}

/** 单个属性 schema 的保守归一：只保留受支持的标量/数组/对象关键字。 */
function normalizeProperty(spec) {
  if (!isRecord(spec)) return {}
  if (Array.isArray(spec.oneOf)) {
    const branches = spec.oneOf.map(normalizeProperty).filter((branch) => Object.keys(branch).length > 0)
    // 受支持的 oneOf 至少需要两个分支；不足时退化成任意值。
    return branches.length >= 2 ? { ...annotations(spec), oneOf: branches } : annotations(spec)
  }
  const type = typeof spec.type === 'string' && SUPPORTED_TYPES.has(spec.type) ? spec.type : undefined
  if (type === undefined) {
    // 未知/缺失类型（包括上游的 `type: 'json'`）都按"任意值"处理。
    return annotations(spec)
  }
  const out = { ...annotations(spec), type }
  if (type === 'array' && isRecord(spec.items)) out.items = normalizeProperty(spec.items)
  if (type === 'object') {
    const nested = isRecord(spec.properties) ? spec.properties : {}
    const nestedProperties = {}
    for (const [name, value] of Object.entries(nested)) nestedProperties[name] = normalizeProperty(value)
    out.properties = nestedProperties
    const nestedRequired = Array.isArray(spec.required)
      ? spec.required.filter((name) => typeof name === 'string' && Object.hasOwn(nestedProperties, name))
      : []
    if (nestedRequired.length > 0) out.required = nestedRequired
    if (typeof spec.additionalProperties === 'boolean') out.additionalProperties = spec.additionalProperties
  }
  if (SCALAR_TYPES.has(type)) {
    if (Array.isArray(spec.enum) && spec.enum.length > 0) out.enum = [...spec.enum]
    if (['string', 'number', 'integer', 'boolean', 'null'].includes(type) && Object.hasOwn(spec, 'const')) {
      out.const = spec.const
    }
  }
  return out
}

/** 只复制 lossless JSON 的注解字段。 */
function annotations(spec) {
  const out = {}
  if (typeof spec.description === 'string') out.description = spec.description
  if (typeof spec.title === 'string') out.title = spec.title
  if (Object.hasOwn(spec, 'default')) {
    try {
      out.default = JSON.parse(JSON.stringify(spec.default))
    } catch {
      // 不可序列化的默认值直接丢弃，不影响 schema 的可用性。
    }
  }
  return out
}

const SUPPORTED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把 MCP 结果里的 content 投影成 DSH 内容块。
 *
 * 只桥接文本块；其他类型（图片、资源）转成一行诊断文本，保留可读性但也让人知道
 * 有内容没显示出来——静默丢弃会让人以为工具返回了空结果。
 *
 * @param {unknown} content MCP CallToolResult.content
 * @param {string} rawName MCP 原始工具名，用于诊断文本
 * @returns {Array<{type: 'text', text: string}>}
 */
export function projectContent(content, rawName) {
  const blocks = Array.isArray(content) ? content : []
  const parts = []
  for (const block of blocks) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    if (isRecord(block) && typeof block.type === 'string') {
      parts.push(`[${rawName}] (unsupported ${block.type} block omitted)`)
    }
  }
  const text = parts.join('\n').trim()
  return [{ type: 'text', text: text === '' ? `[${rawName}] (no output)` : text }]
}

/**
 * 构建一个桥接工具定义。
 *
 * @param {object} options
 * @param {string} options.publicName 模型可见的工具名（`mcp__<server>__<tool>`）
 * @param {string} options.rawName MCP 原始工具名
 * @param {string} options.description 工具描述
 * @param {unknown} options.inputSchema MCP inputSchema
 * @param {import('./pool.js').ProjectHub} options.hub 所属项目连接
 * @param {number} options.timeoutMs 单次调用超时（必须为正数）
 */
export function createBridgedTool({ publicName, rawName, description, inputSchema, hub, timeoutMs }) {
  return {
    name: publicName,
    description: description || `CodeGraph tool "${rawName}"`,
    parameters: toToolParameters(inputSchema),
    timeoutMs,
    output: {
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: {} },
          structuredContent: {},
        },
        required: ['content'],
        additionalProperties: false,
      },
      render(_args, value) {
        const blocks = Array.isArray(value?.content) ? value.content : []
        const text = blocks
          .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
        return [{ type: 'text', text: text || `[${rawName}] (no output)` }]
      },
    },
    async execute(args, exec) {
      const result = await hub.call(rawName, args ?? {}, exec)
      return {
        content: projectContent(result?.content, rawName),
        ...(result?.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      }
    },
  }
}
