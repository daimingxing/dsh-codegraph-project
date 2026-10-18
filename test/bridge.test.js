import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createBridgedTool, projectContent, toToolParameters } from '../lib/bridge.js'

test('parameters 保留 MCP inputSchema 的对象形态，而不是被当作属性名', () => {
  const parameters = toToolParameters({
    type: 'object',
    properties: {
      query: { type: 'string', description: 'search query' },
      maxFiles: { type: 'number', default: 12 },
    },
    required: ['query'],
  })

  // 根级 type/properties/required 必须留在原位：被当成参数名说明走错了编译路径。
  assert.equal(parameters.type, 'object')
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['maxFiles', 'query'])
  assert.deepEqual(parameters.required, ['query'])
  assert.equal(parameters.properties.query.type, 'string')
  assert.equal(parameters.properties.maxFiles.default, 12)
})

test('未知类型降级为空 schema，已知类型与 enum 保留', () => {
  const parameters = toToolParameters({
    type: 'object',
    properties: {
      weird: { type: 'json', description: 'upstream invention' },
      kind: { type: 'string', enum: ['function', 'class'] },
    },
  })

  // 空 schema 表示"任意值"：DSH 的 schema 子集没有 json 类型。
  assert.deepEqual(parameters.properties.weird, { description: 'upstream invention' })
  assert.deepEqual(parameters.properties.kind.enum, ['function', 'class'])
  assert.equal(parameters.required, undefined)
})

test('required 只保留真实存在的属性名', () => {
  const parameters = toToolParameters({
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query', 'ghost'],
  })

  assert.deepEqual(parameters.required, ['query'])
})

test('output.schema 是 DSH 支持的子集，且 render 是函数', () => {
  const tool = createBridgedTool({
    publicName: 'mcp__codegraph__codegraph_explore',
    rawName: 'codegraph_explore',
    description: 'explore',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    hub: { call: async () => ({ content: [] }) },
    timeoutMs: 1000,
  })

  assert.equal(typeof tool.output.render, 'function')
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.output.schema.additionalProperties, false)
  // 该子集不含 `json` 类型，任意值位置必须是空 schema。
  assert.deepEqual(tool.output.schema.properties.structuredContent, {})
})

test('timeoutMs 原样透传（register 会拒绝非正数）', () => {
  const tool = createBridgedTool({
    publicName: 'x',
    rawName: 'x',
    description: '',
    inputSchema: undefined,
    hub: { call: async () => ({ content: [] }) },
    timeoutMs: 60000,
  })

  assert.equal(tool.timeoutMs, 60000)
  // 缺省 inputSchema 也要给出可用的空对象根。
  assert.deepEqual(tool.parameters, { type: 'object', properties: {} })
})

test('execute 把文本块投影为单个 text 内容块', async () => {
  const calls = []
  const tool = createBridgedTool({
    publicName: 'x',
    rawName: 'codegraph_status',
    description: '',
    inputSchema: { type: 'object', properties: {} },
    hub: {
      call: async (rawName, args) => {
        calls.push([rawName, args])
        return { content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] }
      },
    },
    timeoutMs: 1000,
  })

  const result = await tool.execute({ query: 'q' }, {})

  assert.deepEqual(calls, [['codegraph_status', { query: 'q' }]])
  assert.deepEqual(result.content, [{ type: 'text', text: 'first\nsecond' }])
  assert.equal(result.structuredContent, undefined)
})

test('execute 透传 structuredContent', async () => {
  const tool = createBridgedTool({
    publicName: 'x',
    rawName: 'r',
    description: '',
    inputSchema: { type: 'object', properties: {} },
    hub: { call: async () => ({ content: [{ type: 'text', text: 'text' }], structuredContent: { n: 1 } }) },
    timeoutMs: 1000,
  })

  const result = await tool.execute({}, {})

  assert.deepEqual(result.structuredContent, { n: 1 })
})

test('projectContent 对非文本块给出诊断而不是静默丢弃', () => {
  const content = projectContent(
    [{ type: 'text', text: 'keep' }, { type: 'image', data: 'AAA' }],
    'codegraph_explore',
  )

  assert.equal(content.length, 1)
  assert.match(content[0].text, /keep/)
  assert.match(content[0].text, /unsupported image block/)
})

test('projectContent 无输出时给出占位文本', () => {
  assert.deepEqual(projectContent([], 'tool'), [{ type: 'text', text: '[tool] (no output)' }])
  assert.deepEqual(projectContent(undefined, 'tool'), [{ type: 'text', text: '[tool] (no output)' }])
})

test('render 只输出文本块内容', () => {
  const tool = createBridgedTool({
    publicName: 'x',
    rawName: 'r',
    description: '',
    inputSchema: { type: 'object', properties: {} },
    hub: { call: async () => ({ content: [] }) },
    timeoutMs: 1000,
  })

  const rendered = tool.output.render({}, { content: [{ type: 'text', text: 'body' }] })
  assert.deepEqual(rendered, [{ type: 'text', text: 'body' }])

  const empty = tool.output.render({}, { content: [] })
  assert.deepEqual(empty, [{ type: 'text', text: '[r] (no output)' }])
})
