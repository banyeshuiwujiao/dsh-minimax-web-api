/**
 * dsh-minimax-web-api 的 smoke 测试：不联网、不依赖本机后端，全部 hermetic。
 *
 * 覆盖三块：
 *   1. 纯函数转换（消息/工具/错误码/估算）；
 *   2. 流式编排（reasoning / content / tool_calls / usage / 空回合 / 号池为空 / 中止）；
 *   3. 路径解析与契约校验（用假 io，不碰真实磁盘）。
 *
 * @module test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'

import {
  DEFAULTS,
  KNOWN_MODELS,
  MiniMaxWebApiAdapter,
  PROVIDER_ID,
  resolveThinkingEnabled,
} from '../lib/provider.js'
import {
  collectContent,
  estimateTokens,
  failureCodeForMessage,
  failureCodeForStatus,
  formatOpenAiMessages,
  formatOpenAiTools,
  retryAfterMs,
} from '../lib/openai.js'
import { checkContract } from '../lib/contract.js'
import { claimedToday, createCreditKeeper, localDayKey, readClaimState } from '../lib/credits.js'
import { isBackendDir, resolvePython, resolveServerDir, writePointer } from '../lib/paths.js'

let passed = 0
const failures = []

/** 一个断言即一个用例；失败不中断，最后统一报告。 */
function test(name, fn) {
  try {
    const result = fn()
    if (result && typeof result.then === 'function') throw new Error('用例必须是同步函数（异步请用 testAsync）')
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

// ---------------------------------------------------------------- 纯函数

test('DEFAULTS.baseUrl 只绑回环', () => {
  assert.equal(new URL(DEFAULTS.baseUrl).hostname, '127.0.0.1')
})

test('KNOWN_MODELS 都是后端目录里的 id，且不含图像模型', () => {
  const ids = KNOWN_MODELS.map((m) => m.id)
  assert.deepEqual(ids, [
    'minimax-agent',
    'minimax-m3.1-flash',
    'minimax-m3.1-flash-thinking',
    'minimax-m3',
    'minimax-m3-thinking',
  ])
  assert.ok(!ids.includes('minimax-image'), '图像模型会走对话链路，不能列进来')
})

test('resolveThinkingEnabled 认已知模型，未知模型按名字猜', () => {
  assert.equal(resolveThinkingEnabled('minimax-m3-thinking'), true)
  assert.equal(resolveThinkingEnabled('minimax-m3.1-flash'), false)
  assert.equal(resolveThinkingEnabled('some-thinking-model'), true)
  assert.equal(resolveThinkingEnabled('plain'), false)
})

test('collectContent 抽文本、保留 http 图片、告警丢弃的块', () => {
  const got = collectContent([
    { type: 'text', text: '看这张图' },
    { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
    { type: 'image', source: { type: 'base64', data: 'AAA' } },
    { type: 'audio', data: 'zzz' },
  ])
  assert.equal(got.text, '看这张图')
  assert.deepEqual(got.images, ['https://x/y.png'])
  assert.deepEqual(got.skipped, ['image(非URL)', 'audio'])
})

test('formatOpenAiMessages 透传 system/developer，保留 tool 往返', () => {
  const warnings = []
  const messages = formatOpenAiMessages(
    {
      system: '你是助手',
      messages: [
        { role: 'developer', content: '开发者指令' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '调用工具', toolCalls: [{ id: 'c1', name: 'read', arguments: '{"p":"a"}' }] },
        { role: 'tool', toolCallId: 'c1', content: '文件内容' },
        { role: 'weird', content: 'x' },
      ],
    },
    (m) => warnings.push(m),
  )
  assert.deepEqual(messages[0], { role: 'system', content: '你是助手' })
  assert.deepEqual(messages[1], { role: 'system', content: '开发者指令' })
  assert.equal(messages[2].role, 'user')
  assert.equal(messages[3].tool_calls[0].function.name, 'read')
  assert.equal(messages[4].role, 'tool')
  assert.equal(messages[4].tool_call_id, 'c1')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /weird/)
})

test('user 带图片时产出 image_url 块', () => {
  const messages = formatOpenAiMessages({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'https://a/b.jpg' } }] }],
  })
  assert.deepEqual(messages[0].content[1], { type: 'image_url', image_url: { url: 'https://a/b.jpg' } })
})

test('formatOpenAiTools 默认不裁剪，超预算才加省略号', () => {
  const long = 'x'.repeat(100)
  const tools = [{ name: 't', description: long, parameters: { type: 'object' } }]
  assert.equal(formatOpenAiTools(tools, 0)[0].function.description, long)
  assert.ok(formatOpenAiTools(tools, 10)[0].function.description.endsWith('…'))
  assert.equal(formatOpenAiTools([], 0), undefined)
})

test('estimateTokens 中文按字、英文按 4 字', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('中文'), 2)
  assert.equal(estimateTokens('abcd'), 1)
})

test('failureCodeForStatus 覆盖内核词表', () => {
  assert.equal(failureCodeForStatus(401), 'AUTH')
  assert.equal(failureCodeForStatus(403), 'AUTH')
  assert.equal(failureCodeForStatus(402), 'QUOTA')
  assert.equal(failureCodeForStatus(429), 'RATE_LIMIT')
  assert.equal(failureCodeForStatus(400), 'INVALID_REQUEST')
  assert.equal(failureCodeForStatus(413), 'INVALID_REQUEST')
  assert.equal(failureCodeForStatus(503), 'SERVER')
  assert.equal(failureCodeForStatus(418), 'HTTP_418')
  assert.equal(failureCodeForStatus(400, 'maximum context length exceeded'), 'CONTEXT_WINDOW_EXCEEDED')
})

test('failureCodeForMessage 把"号池为空"判成 MISSING_CREDENTIAL', () => {
  assert.equal(failureCodeForMessage('no accounts configured; add one in the console'), 'MISSING_CREDENTIAL')
  assert.equal(failureCodeForMessage('nothing to see'), '')
})

test('failureCodeForMessage 从 5xx 正文里认出"余额不足"（上游把 402 包在 500 里）', () => {
  // 真机上抓到的原文：MiniMax 上游回 HTTP 500，正文里才藏着 402 与余额错误。
  const real = 'minimax llm HTTP 500: {"error":"{\\"error\\":\\"unexpected status code: 402, response: '
    + '{\\\\\\"type\\\\\\":\\\\\\"error\\\\\\",\\\\\\"error\\\\\\":{\\\\\\"type\\\\\\":'
    + '\\\\\\"insufficient_balance_error\\\\\\",\\\\\\"message\\\\\\":\\\\\\"insufficient balance (1008)\\\\\\\"}}"}"}'
  assert.equal(failureCodeForMessage(real), 'QUOTA')
  assert.equal(failureCodeForMessage('余额不足'), 'QUOTA')
  assert.equal(failureCodeForMessage('insufficient_balance_error'), 'QUOTA')
})

test('failureCodeForMessage 从 5xx 正文里认出凭据被拒', () => {
  assert.equal(failureCodeForMessage('unexpected status code: 401, invalid credential'), 'AUTH')
  assert.equal(failureCodeForMessage('token expired'), 'AUTH')
})

test('retryAfterMs 接受秒数与 HTTP 日期', () => {
  assert.equal(retryAfterMs('2'), 2000)
  assert.equal(retryAfterMs(''), undefined)
  assert.ok(retryAfterMs(new Date(Date.now() + 5000).toUTCString()) > 3000)
})

// ---------------------------------------------------------------- 契约与路径

test('checkContract 认真正的 /health 形状', () => {
  const ok = checkContract({ status: 'degraded', accounts: 0, usableAccounts: 0, upstream: 'x' })
  assert.equal(ok.ok, true)
})

test('checkContract 拒绝别的服务', () => {
  assert.equal(checkContract(null).ok, false)
  assert.equal(checkContract({ ok: true }).ok, false)
})

test('isBackendDir 要 run.py 与 app/server.py 同时存在', () => {
  const files = new Set(['C:/r/run.py', 'C:/r/app/server.py'])
  assert.equal(isBackendDir('C:/r', (p) => files.has(p.replace(/\\/g, '/'))), true)
  assert.equal(isBackendDir('C:/nope', (p) => files.has(p.replace(/\\/g, '/'))), false)
})

test('resolveServerDir 优先级：config > env > 指针，坏配置不否决后续', () => {
  const backend = 'C:/repo/minimax2api'
  // 只有指针指向的后端目录成立：run.py 与 app/server.py 都存在。
  const io = {
    env: { DSH_MINIMAX2API_DIR: 'C:/env/mm' },
    home: 'C:/home/u',
    exists: (p) => {
      const norm = p.replace(/\\/g, '/')
      return norm === 'C:/home/u/.dsh/minimax2api.json'
        || norm === `${backend}/run.py`
        || norm === `${backend}/app/server.py`
    },
    read: () => JSON.stringify({ serverDir: backend, gitRev: 'abc' }),
    pluginDir: '',
  }
  // 配置写错 → 继续往下找，env 也不成立 → 落到指针
  const result = resolveServerDir({ serverDir: 'C:/typo' }, io)
  assert.equal(result.source, 'pointer')
  assert.equal(result.dir, backend)
  // 配置真的成立时优先级最高
  const configured = resolveServerDir({ serverDir: backend }, io)
  assert.equal(configured.source, 'config')
})

test('resolvePython 先看配置，再看 venv', () => {
  const venv = 'C:/r/.venv/Scripts/python.exe'
  const io = {
    env: {},
    home: 'C:/home/u',
    platform: 'win32',
    exists: (p) => p.replace(/\\/g, '/') === venv,
  }
  assert.equal(resolvePython({}, 'C:/r', io).source, 'venv')
  assert.equal(resolvePython({ pythonPath: venv }, 'C:/r', io).source, 'config')
  assert.equal(resolvePython({}, '', { ...io, exists: () => false }).path, 'python.exe')
})

test('writePointer 落盘形状可被 readPointer 读回', () => {
  const writes = []
  const io = { mkdirSync: () => {}, writeFileSync: (p, text) => writes.push([p, text]) }
  writePointer('~/.dsh/minimax2api.json', 'C:/r', 'abc', 'C:/r/.venv/Scripts/python.exe', io)
  assert.equal(writes.length, 1)
  const parsed = JSON.parse(writes[0][1])
  assert.equal(parsed.serverDir, 'C:/r')
  assert.equal(parsed.gitRev, 'abc')
  assert.equal(parsed.pythonPath, 'C:/r/.venv/Scripts/python.exe')
})

// ---------------------------------------------------------------- 流式编排

/** 构造一个只读 SSE 的假 fetch，并记录请求体。 */
function fakeFetch(sseText, { status = 200, bodyText = '' } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init, json: JSON.parse(init.body) })
    if (status !== 200) {
      return new Response(bodyText, { status, headers: { 'content-type': 'application/json' } })
    }
    return new Response(sseText, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  impl.calls = calls
  return impl
}

const fakeManager = { ensure: async () => ({ status: 'ok' }) }

/** 跑一遍 stream，收集所有 chunk。 */
async function collect(model, options, fetchImpl, opts = {}) {
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const adapter = new MiniMaxWebApiAdapter({ autoStart: false, ...opts }, fakeManager, { warn() {}, debug() {} })
    const chunks = []
    for await (const chunk of adapter.stream(model, options, { ...DEFAULTS, autoStart: false, ...opts }, fakeManager)) {
      chunks.push(chunk)
    }
    return chunks
  } finally {
    globalThis.fetch = original
  }
}

const sse = (...payloads) =>
  payloads.map((p) => (typeof p === 'string' ? p : `data: ${JSON.stringify(p)}\n\n`)).join('') + 'data: [DONE]\n\n'

const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] })

await testAsync('流式：reasoning → text → usage → stop，块边界正确', async () => {
  const fetchImpl = fakeFetch(
    sse(
      delta({ role: 'assistant' }),
      delta({ reasoning_content: '想一下' }),
      delta({ reasoning_content: '，好了' }),
      delta({ content: '答案' }),
      delta({}, 'stop'),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30 } },
    ),
  )
  const chunks = await collect('minimax-agent', { system: 's', messages: [{ role: 'user', content: 'hi' }] }, fetchImpl)
  const types = chunks.map((c) => c.type)
  assert.deepEqual(types, [
    'block-start', 'reasoning-delta', 'reasoning-delta', 'block-end',
    'block-start', 'text-delta', 'block-end',
    'usage', 'finish',
  ])
  assert.equal(chunks[1].text, '想一下')
  assert.equal(chunks[3].block.text, '想一下，好了')
  assert.equal(chunks[6].block.text, '答案')
  assert.deepEqual(chunks[7].usage, { inputTokens: 120, outputTokens: 30 })
  assert.deepEqual(chunks[8].reason, { kind: 'stop' })
})

await testAsync('流式：工具调用整块下发，finish 为 tool-calls', async () => {
  const fetchImpl = fakeFetch(
    sse(
      delta({ content: '我来读文件' }),
      delta({
        tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.md"}' } },
        ],
      }),
      delta({}, 'tool_calls'),
    ),
  )
  const chunks = await collect('minimax-agent', { messages: [{ role: 'user', content: 'read a.md' }], tools: [{ name: 'read', description: 'd', parameters: {} }] }, fetchImpl)
  const call = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
  assert.ok(call, '必须产出 tool-call 块')
  assert.equal(call.block.id, 'call_1')
  assert.equal(call.block.name, 'read')
  assert.equal(call.block.arguments, '{"path":"a.md"}')
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

await testAsync('流式：同 index 的分片参数会被拼成一个调用', async () => {
  const fetchImpl = fakeFetch(
    sse(
      delta({ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'read', arguments: '{"a"' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
      delta({}, 'tool_calls'),
    ),
  )
  const chunks = await collect('minimax-agent', { messages: [{ role: 'user', content: 'x' }] }, fetchImpl)
  const calls = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].block.arguments, '{"a":1}')
})

await testAsync('流式：零产出报 EMPTY_RESPONSE（不能静默 stop）', async () => {
  const fetchImpl = fakeFetch(sse(delta({}, 'stop')))
  const chunks = await collect('minimax-agent', { messages: [{ role: 'user', content: 'hi' }] }, fetchImpl)
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE')
})

await testAsync('流式：号池为空 → MISSING_CREDENTIAL（不是可重试的 TRANSPORT）', async () => {
  const fetchImpl = fakeFetch(
    sse({ error: { message: 'no accounts configured; add one in the console', type: 'server_error' } }),
  )
  const chunks = await collect('minimax-agent', { messages: [{ role: 'user', content: 'hi' }] }, fetchImpl)
  assert.equal(chunks.at(-1).reason.failure.code, 'MISSING_CREDENTIAL')
})

await testAsync('HTTP 400 + 上下文超长 → CONTEXT_WINDOW_EXCEEDED', async () => {
  const fetchImpl = fakeFetch('', {
    status: 400,
    bodyText: JSON.stringify({ error: { code: 'invalid_request', message: 'maximum context length exceeded' } }),
  })
  const chunks = await collect('minimax-agent', { messages: [{ role: 'user', content: 'x' }] }, fetchImpl)
  const reason = chunks.at(-1).reason
  assert.equal(reason.kind, 'error')
  assert.equal(reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(reason.failure.status, 400)
})

await testAsync('请求体：带上 model/stream/max_tokens/tools，且 max_tokens 来自内核预算', async () => {
  const fetchImpl = fakeFetch(sse(delta({ content: 'ok' }), delta({}, 'stop')))
  await collect(
    'minimax-m3.1-flash',
    { messages: [{ role: 'user', content: 'hi' }], maxTokens: 1234, tools: [{ name: 't', description: 'd' }] },
    fetchImpl,
  )
  const body = fetchImpl.calls[0].json
  assert.equal(body.model, 'minimax-m3.1-flash')
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 1234)
  assert.equal(body.tools[0].type, 'function')
  assert.deepEqual(body.stream_options, { include_usage: true })
})

await testAsync('请求体：内核没给预算时回落到 defaultMaxTokens（后端缺省 4096 会截断长输出）', async () => {
  const fetchImpl = fakeFetch(sse(delta({ content: 'ok' }), delta({}, 'stop')))
  await collect('minimax-m3.1-flash', { messages: [{ role: 'user', content: 'hi' }] }, fetchImpl)
  // collect() 绑定的是 DEFAULTS（defaultMaxTokens = 32768）
  assert.equal(fetchImpl.calls[0].json.max_tokens, 32768)
})

await testAsync('用户中止 → ABORTED（不进重试）', async () => {
  const controller = new AbortController()
  controller.abort()
  const adapter = new MiniMaxWebApiAdapter({ autoStart: false }, fakeManager, { warn() {}, debug() {} })
  const chunks = []
  for await (const chunk of adapter.stream('minimax-agent', { signal: controller.signal }, { ...DEFAULTS, autoStart: false }, fakeManager)) {
    chunks.push(chunk)
  }
  assert.equal(chunks.at(-1).reason.kind, 'aborted')
  assert.equal(chunks.at(-1).reason.failure.code, 'ABORTED')
})

await testAsync('管理器起不来 → 直接报错，不抛异常', async () => {
  const failing = { ensure: async () => { throw Object.assign(new Error('后端目录没找到'), { failureCode: 'BACKEND_STALE' }) } }
  const adapter = new MiniMaxWebApiAdapter({ autoStart: false }, failing, { warn() {}, debug() {} })
  const chunks = []
  for await (const chunk of adapter.stream('minimax-agent', {}, { ...DEFAULTS, autoStart: false }, failing)) {
    chunks.push(chunk)
  }
  assert.equal(chunks.at(-1).reason.failure.code, 'BACKEND_STALE')
})

// ---------------------------------------------------------------- 适配器元数据

await testAsync('listModels / resolveModel 申报模态与上下文', async () => {
  const adapter = new MiniMaxWebApiAdapter({}, null, { warn() {}, debug() {} })
  const models = await adapter.listModels(PROVIDER_ID)
  assert.equal(models.length, KNOWN_MODELS.length)
  const flash = models.find((m) => m.id === 'minimax-m3.1-flash')
  assert.deepEqual(flash.inputModalities, ['text', 'image'])
  const resolved = await adapter.resolveModel(PROVIDER_ID, 'minimax-m3.1-flash', DEFAULTS)
  assert.equal(resolved.context.contextWindow, 512000)
  assert.equal(resolved.defaultMaxTokens, 32768)
})

await testAsync('prepareCall 返回可调用的 stream', async () => {
  const adapter = new MiniMaxWebApiAdapter({ autoStart: false }, fakeManager, { warn() {}, debug() {} })
  const prepared = await adapter.prepareCall(PROVIDER_ID, 'minimax-m3')
  assert.equal(prepared.model.id, 'minimax-m3')
  assert.equal(typeof prepared.stream, 'function')
})

// ---------------------------------------------------------------- 每日积分领取器

// 假子进程：只实现领取器用到的接口（stdout/stderr 收数据，close 回报退出码）。
function fakeChild(exitCode, output = '已领取') {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from(output))
    child.emit('close', exitCode)
  }, 0)
  return child
}

/** 内存里的状态文件（不碰真实磁盘）。 */
function fakeStateIo(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    io: {
      existsSync: (p) => files.has(p),
      readFileSync: (p) => files.get(p),
      mkdirSync: () => {},
      writeFileSync: (p, data) => files.set(p, data),
    },
  }
}

test('localDayKey 用本地时区给 YYYY-MM-DD', () => {
  assert.equal(localDayKey(new Date(2026, 9, 21, 9, 5)), '2026-10-21')
  assert.equal(localDayKey(new Date(2026, 0, 1, 0, 0)), '2026-01-01')
})

test('claimedToday 只认当天且 ok 的记录', () => {
  const state = { days: { '2026-10-21': { ok: true }, '2026-10-20': { ok: false } } }
  assert.equal(claimedToday(state, '2026-10-21'), true)
  assert.equal(claimedToday(state, '2026-10-20'), false)
  assert.equal(claimedToday(state, '2026-10-22'), false)
  assert.equal(claimedToday({}, '2026-10-21'), false)
})

test('readClaimState 遇到坏文件当没领过', () => {
  const io = { existsSync: () => true, readFileSync: () => '{ 这不是 json' }
  assert.deepEqual(readClaimState('x.json', io), { days: {} })
})

await testAsync('领取器：当天已领过就不再拉起脚本', async () => {
  const { io, files } = fakeStateIo({ 'state.json': JSON.stringify({ days: { '2026-10-21': { ok: true } } }) })
  let spawned = 0
  const keeper = createCreditKeeper({
    stateFile: 'state.json',
    home: '/home/x',
    now: () => new Date(2026, 9, 21, 12, 0),
    exists: () => true,
    stateIo: io,
    spawnImpl: () => { spawned += 1; return fakeChild(0) },
    resolve: () => ({ pythonPath: 'C:/py/python.exe', scriptPath: 'C:/p/claim.py', serverDir: 'C:/srv' }),
  })
  const result = await keeper.runOnce('test')
  assert.equal(spawned, 0)
  assert.equal(result.skipped, true)
})

await testAsync('领取器：没领过就拉起脚本，成功后记下当天', async () => {
  const { io, files } = fakeStateIo()
  const spawned = []
  const keeper = createCreditKeeper({
    stateFile: 'state.json',
    home: '/home/x',
    now: () => new Date(2026, 9, 21, 12, 0),
    exists: () => true,
    stateIo: io,
    spawnImpl: (python, args, opts) => { spawned.push({ python, args, env: opts.env }); return fakeChild(0, '今天已领过') },
    resolve: () => ({ pythonPath: 'C:/py/python.exe', scriptPath: 'C:/p/claim.py', serverDir: 'C:/srv' }),
  })
  const result = await keeper.runOnce('test')
  assert.equal(result.ok, true)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].python, 'C:/py/python.exe')
  assert.deepEqual(spawned[0].args, ['C:/p/claim.py'])
  // 后端目录要通过环境变量传给脚本（脚本自己也要能解析后端目录）
  assert.equal(spawned[0].env.MINIMAX2API_DIR, 'C:/srv')
  const saved = JSON.parse(files.get('state.json'))
  assert.equal(saved.days['2026-10-21'].ok, true)
})

await testAsync('领取器：脚本失败不记成功（明天还能再领）', async () => {
  const { io, files } = fakeStateIo()
  const keeper = createCreditKeeper({
    stateFile: 'state.json',
    home: '/home/x',
    now: () => new Date(2026, 9, 21, 12, 0),
    exists: () => true,
    stateIo: io,
    spawnImpl: () => fakeChild(1, 'boom'),
    resolve: () => ({ pythonPath: 'C:/py/python.exe', scriptPath: 'C:/p/claim.py' }),
  })
  const result = await keeper.runOnce('test')
  assert.equal(result.ok, false)
  assert.equal(files.has('state.json'), false)
})

await testAsync('领取器：缺解释器时只告警不抛', async () => {
  const { io } = fakeStateIo()
  const warnings = []
  const keeper = createCreditKeeper({
    stateFile: 'state.json',
    home: '/home/x',
    now: () => new Date(2026, 9, 21, 12, 0),
    exists: () => false,
    stateIo: io,
    logger: { warn: (m) => warnings.push(m), debug: () => {} },
    resolve: () => ({ pythonPath: 'C:/py/python.exe' }),
  })
  const result = await keeper.runOnce('test')
  assert.equal(result.ok, false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /Python/)
})

await testAsync('领取器：脚本卡住时按硬超时终止，不无限挂着', async () => {
  const { io, files } = fakeStateIo()
  let killed = false
  const keeper = createCreditKeeper({
    stateFile: 'state.json',
    home: '/home/x',
    now: () => new Date(2026, 9, 21, 12, 0),
    exists: () => true,
    stateIo: io,
    timeoutMs: 50,
    // 永远不 close 的子进程：模拟上游卡死
    spawnImpl: () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => { killed = true }
      return child
    },
    resolve: () => ({ pythonPath: 'C:/py/python.exe', scriptPath: 'C:/p/claim.py' }),
  })
  const result = await keeper.runOnce('test')
  assert.equal(result.ok, false)
  assert.equal(killed, true)
  assert.equal(files.has('state.json'), false)
})

// ---------------------------------------------------------------- 汇总

const total = passed + failures.length
if (failures.length > 0) {
  console.error(`❌ smoke 未通过：${failures.length}/${total}`)
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log(`✅ smoke 全部通过（${passed} 个用例）`)

// 直接执行判定必须走 pathToFileURL：Windows 上手拼 file:// 盘符路径比不上，会静默不执行。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 已经在上面的顶层 await 里跑完了，这里只是显式声明入口。
}