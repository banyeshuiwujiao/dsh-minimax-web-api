/**
 * dsh-minimax-web-api 的视觉回归：内核的图片块怎么变成上游看得见的像素。
 *
 * 覆盖三块（全部 hermetic：不联网、不依赖本机后端）：
 *   1. lib/images.js —— 持久图片块 → data: URL；
 *   2. lib/openai.js —— data: URL 与工具结果里的图片都要被转发；
 *   3. lib/provider.js —— 适配器在真实请求体里把图片发出去。
 *
 * 为什么单独一个文件：视觉这条链有**三层**（内核引用 → 适配器 → 反代），
 * 任何一层把图片弄丢了都不会报错，只会让模型"看不见图却照样回答"——
 * 这类故障只有专门的断言才拦得住。
 *
 * @module test/vision.mjs
 */

import assert from 'node:assert/strict'

import { DEFAULTS, KNOWN_MODELS, MiniMaxWebApiAdapter } from '../lib/provider.js'
import { collectContent, formatOpenAiMessages } from '../lib/openai.js'
import {
  attachmentRefOf,
  imageDataUrl,
  imageHandleText,
  isForwardableUrl,
  resolveMessageImages,
} from '../lib/images.js'

let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`${name}: ${error?.message || error}`)
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`${name}: ${error?.message || error}`)
  }
}

/** 一张 1x1 的 PNG（base64）。 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 内核给的持久图片块。 */
function dshImageBlock(id = 'sha256:abc123', bytes = 3) {
  return {
    type: 'image',
    attachment: {
      attachmentId: id,
      name: 'shot.png',
      mediaType: 'image/png',
      width: 640,
      height: 480,
      bytes,
    },
  }
}

/** 假 attachment 服务：返回一份请求版本。 */
function fakeAttachments(overrides = {}) {
  return {
    calls: [],
    async readImageRequest(ref, target, signal) {
      this.calls.push({ ref, target })
      if (signal?.aborted === true) throw new Error('aborted')
      return {
        variantId: 'variant-1',
        data: Buffer.from(PNG_BASE64, 'base64'),
        mediaType: 'image/png',
        bytes: 3,
        width: 640,
        height: 480,
      }
    },
    ...overrides,
  }
}

// ------------------------------------------------------------------ 纯函数

test('isForwardableUrl 认 http(s) 与 data:，不认别的', () => {
  assert.equal(isForwardableUrl('https://x/y.png'), true)
  assert.equal(isForwardableUrl('http://x/y.png'), true)
  assert.equal(isForwardableUrl(`data:image/png;base64,${PNG_BASE64}`), true)
  assert.equal(isForwardableUrl('file:///c:/y.png'), false)
  assert.equal(isForwardableUrl('/c:/y.png'), false)
  assert.equal(isForwardableUrl(''), false)
  assert.equal(isForwardableUrl(undefined), false)
})

test('attachmentRefOf 只认内核的持久引用，不认 OpenAI 形状', () => {
  assert.equal(attachmentRefOf(dshImageBlock()).attachmentId, 'sha256:abc123')
  assert.equal(attachmentRefOf({ type: 'image_url', image_url: { url: 'https://x/y.png' } }), null)
  assert.equal(attachmentRefOf({ type: 'image', attachment: {} }), null)
  assert.equal(attachmentRefOf(null), null)
})

test('imageDataUrl 用请求版本的 mediaType 与字节', () => {
  const url = imageDataUrl({ data: Buffer.from('abc'), mediaType: 'image/jpeg' })
  assert.equal(url, 'data:image/jpeg;base64,YWJj')
})

test('imageHandleText 给出可指认的句柄', () => {
  const text = imageHandleText({ attachmentId: 'sha256:abc123', name: 'shot.png' }, { width: 640, height: 480 })
  assert.match(text, /"shot\.png" \(sha256:abc123\)/)
  assert.match(text, /640x480px/)
})

test('collectContent 把 data: URL 当图片，不再当"非 URL"丢掉', () => {
  const got = collectContent([
    { type: 'text', text: '看这张图' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
  ])
  assert.deepEqual(got.images, [`data:image/png;base64,${PNG_BASE64}`])
  assert.deepEqual(got.skipped, [])
})

test('collectContent 把内核的图片块单列出来，不当成已转发', () => {
  const got = collectContent([dshImageBlock()])
  assert.deepEqual(got.images, [])
  assert.equal(got.imageBlocks.length, 1)
  assert.deepEqual(got.skipped, [])
})

test('formatOpenAiMessages 转发用户消息里的 data: URL', () => {
  const messages = formatOpenAiMessages({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
      ],
    }],
  })
  assert.equal(messages[0].content[0].type, 'text')
  assert.equal(messages[0].content[1].type, 'image_url')
  assert.match(messages[0].content[1].image_url.url, /^data:image\/png;base64,/)
})

test('formatOpenAiMessages 转发工具结果里的图片（read_image 的结果）', () => {
  const messages = formatOpenAiMessages({
    messages: [{
      role: 'tool',
      toolCallId: 'call_1',
      content: [
        { type: 'text', text: '<type>image</type>' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
      ],
    }],
  })
  assert.equal(messages[0].role, 'tool')
  assert.equal(messages[0].tool_call_id, 'call_1')
  assert.equal(messages[0].content[0].type, 'text')
  assert.equal(messages[0].content[1].type, 'image_url')
})

// ------------------------------------------------------------- 图片解析层

await testAsync('resolveMessageImages 把持久引用换成 data: URL 的 image_url 块', async () => {
  const attachments = fakeAttachments()
  const { messages, resolved, failed } = await resolveMessageImages(
    [{ role: 'user', content: [{ type: 'text', text: '看这张图' }, dshImageBlock()] }],
    (ref) => attachments.readImageRequest(ref, { width: 640, height: 480, maxBytes: 1024 }),
  )
  assert.equal(resolved, 1)
  assert.equal(failed, 0)
  const blocks = messages[0].content
  assert.equal(blocks.length, 3)
  assert.equal(blocks[0].text, '看这张图')
  assert.match(blocks[1].text, /Image "shot\.png"/)
  assert.equal(blocks[2].type, 'image_url')
  assert.match(blocks[2].image_url.url, /^data:image\/png;base64,/)
})

await testAsync('resolveMessageImages 读失败的图换成占位文字，不静默消失', async () => {
  const { messages, resolved, failed } = await resolveMessageImages(
    [{ role: 'user', content: [dshImageBlock('sha256:dead')] }],
    async () => {
      throw new Error('read failed')
    },
  )
  assert.equal(resolved, 0)
  assert.equal(failed, 1)
  assert.match(messages[0].content[0].text, /image omitted because it could not be read/)
})

await testAsync('resolveMessageImages 没有图片块时原样返回', async () => {
  const input = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  const result = await resolveMessageImages(input, async () => {
    throw new Error('不该被调用')
  })
  assert.equal(result.resolved, 0)
  assert.equal(result.failed, 0)
  assert.equal(result.messages[0], input[0])
})

// ------------------------------------------------------------- 适配器整轮

/** 跑一遍 stream，并交出真正发出去的请求体。 */
async function runStream(options, { attachments, opts = {} } = {}) {
  const original = globalThis.fetch
  let sent = null
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body)
    const sse = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join('')
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const hostCtx = attachments === undefined ? null : { get: (name) => (name === 'attachments' ? attachments : undefined) }
    const adapter = new MiniMaxWebApiAdapter(
      { autoStart: false, ...opts },
      { ensure: async () => ({ status: 'ok' }) },
      { warn() {}, debug() {} },
      hostCtx,
    )
    const chunks = []
    for await (const chunk of adapter.stream(
      'minimax-agent',
      options,
      { ...DEFAULTS, autoStart: false, ...opts },
      { ensure: async () => ({ status: 'ok' }) },
    )) {
      chunks.push(chunk)
    }
    return { sent, chunks }
  } finally {
    globalThis.fetch = original
  }
}

await testAsync('适配器：内核的图片块变成请求体里的 data: URL', async () => {
  const attachments = fakeAttachments()
  const { sent } = await runStream(
    {
      system: '你是助手',
      messages: [{ role: 'user', content: [{ type: 'text', text: '看这张图' }, dshImageBlock('sha256:big', 10 * 1024 * 1024)] }],
    },
    { attachments },
  )
  const blocks = sent.messages[1].content
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[1].type, 'image_url')
  assert.match(blocks[1].image_url.url, /^data:image\/png;base64,/)
  assert.equal(attachments.calls.length, 1)
  // 字节上限要传给 attachment 服务，图片大了由它降质而不是原样发几 MB。
  assert.equal(attachments.calls[0].target.maxBytes, DEFAULTS.maxRequestImageBytes)
})

await testAsync('适配器：小图不被上限压成 0 字节目标', async () => {
  const attachments = fakeAttachments()
  await runStream(
    { messages: [{ role: 'user', content: [dshImageBlock('sha256:small', 3)] }] },
    { attachments },
  )
  assert.equal(attachments.calls[0].target.maxBytes, 3)
})

await testAsync('适配器：工具结果里的图片也进请求体', async () => {
  const attachments = fakeAttachments()
  const { sent } = await runStream(
    {
      messages: [
        { role: 'user', content: '看这张图' },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_1', name: 'read_image', arguments: { file_path: 'x.png' } }],
        },
        { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '<type>image</type>' }, dshImageBlock()] },
      ],
    },
    { attachments },
  )
  const toolMessage = sent.messages.find((m) => m.role === 'tool')
  assert.ok(toolMessage, '工具结果消息必须还在')
  assert.equal(toolMessage.content[0].type, 'text')
  assert.equal(toolMessage.content[1].type, 'image_url')
})

await testAsync('适配器：没有 attachment 服务时告警并留占位，不静默丢图', async () => {
  const original = globalThis.fetch
  const warnings = []
  globalThis.fetch = async (url, init) => {
    globalThis.__sent = JSON.parse(init.body)
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }
  try {
    const adapter = new MiniMaxWebApiAdapter(
      { autoStart: false },
      { ensure: async () => ({ status: 'ok' }) },
      { warn: (m) => warnings.push(m), debug() {} },
      { get: () => undefined },
    )
    const chunks = []
    for await (const chunk of adapter.stream(
      'minimax-agent',
      { messages: [{ role: 'user', content: [dshImageBlock()] }] },
      { ...DEFAULTS, autoStart: false },
      { ensure: async () => ({ status: 'ok' }) },
    )) {
      chunks.push(chunk)
    }
    assert.ok(warnings.some((w) => /attachment/.test(w)), `应当告警缺 attachment 服务，实际告警：${JSON.stringify(warnings)}`)
    const sent = globalThis.__sent
    const text = JSON.stringify(sent.messages)
    assert.match(text, /image omitted because it could not be read/)
  } finally {
    globalThis.fetch = original
    delete globalThis.__sent
  }
})

await testAsync('适配器：声明了视觉的模型才允许图片（minimax-agent 也要算）', async () => {
  const adapter = new MiniMaxWebApiAdapter({ autoStart: false }, null, { warn() {}, debug() {} })
  // 目录里声明 image: true 的模型，对外都必须申报 ['text','image']。
  // 2026-10-22 选择器精简后目录只剩 minimax-agent，这条断言因此尤其重要：
  // 它是号池默认入口，漏了 image 就等于"默认模型看不见图"。
  const visual = KNOWN_MODELS.filter((m) => m.image)
  assert.ok(visual.some((m) => m.id === 'minimax-agent'), 'minimax-agent 必须声明视觉')
  for (const model of visual) {
    const info = await adapter.resolveModel('minimax-web-api', model.id)
    assert.deepEqual(info.inputModalities, ['text', 'image'], `${model.id} 应当声明支持图片`)
  }
})

// ------------------------------------------------------------------ 汇总

if (failures.length > 0) {
  console.error(`\n❌ 视觉回归失败 ${failures.length} 个：`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`✅ 视觉回归通过：${passed} 个用例`)
