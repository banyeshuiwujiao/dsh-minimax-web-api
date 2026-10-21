// 真实 DSH 内核的一整轮：kernel → 适配器 → minimax2api → MiniMax 上游 → 回到 kernel。
//
// 为什么要有这个：prepareCall 回归只验"契约形状"（内核能不能装配），而
// 2026-10-21 11:05 那次真实会话（session-a26a2505-…）翻车时，prepareCall 是好的、
// 装配也是好的，**坏的是真正的回合**：上游 401 → 号池被退休 → 三个回合全废。
// 所以这里必须真跑一轮：真实出字 + 真实工具调用 + 真实 usage。
//
// 依赖：本机 minimax2api 后端在跑（127.0.0.1:4555）且号池里有可用账号。
// 失败时先看：
//   Invoke-RestMethod http://127.0.0.1:4555/health
//   python scripts\keep_tokens_alive.py --force
//
// 用法: node test/kernel_turn_regression.mjs

import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { PROVIDER_ID, MiniMaxWebApiAdapter } from '../lib/provider.js'

const llmRoot = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-llm')
const { LlmRuntime } = await import(pathToFileURL(join(llmRoot, 'lib/index.js')).href)
const cordisRoot = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'cordis')
const { Context } = await import(pathToFileURL(join(cordisRoot, 'lib', 'index.js')).href)

const TOOLS = [
  {
    name: 'get_weather',
    description: '查某个城市的天气。',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名' } },
      required: ['city'],
    },
  },
]

// 内核的 prepared.stream(options) 有两个硬约束：
//   1) options 里 provider/model/maxTokens/... 必须与 prepareCall 解析出的 config **完全一致**
//      （callConfigEquals），所以只能拿 prepared.config 去拼 options；
//   2) 一个 prepared call **只能 dispatch 一次** → 每轮都要重新 prepareCall。
async function turn({ messages, tools }) {
  const prepared = await ctx.llm.prepareCall({ provider: PROVIDER_ID, model: 'minimax-agent' })
  const options = { ...prepared.config, messages, ...(tools ? { tools } : {}) }
  const chunks = []
  for await (const chunk of prepared.stream(options)) chunks.push(chunk)
  return chunks
}

const ctx = new Context()
await ctx.plugin(LlmRuntime)
try {
  const adapter = new MiniMaxWebApiAdapter({
    baseUrl: 'http://127.0.0.1:4555',
    autoStart: false, // 后端已经在跑，复用它
  })
  ctx.llm.registerAdapter([PROVIDER_ID], adapter)

  // ---- 第一轮：普通对话 -----------------------------------------------------
  // 内核的消息 content 是**块数组**（{type:'text', text}），不是字符串——
  // 传字符串内核自己就会报 "content.some is not a function"。
  const plain = await turn({
    messages: [{ role: 'user', content: [{ type: 'text', text: '用一句话说明什么是向量数据库。' }] }],
  })
  const text = plain
    .filter((c) => c.type === 'text-delta')
    .map((c) => c.text ?? c.delta ?? '')
    .join('')
  const finish = plain.at(-1)
  const usage = plain.find((c) => c.type === 'usage')

  console.log('第一轮正文:', text.slice(0, 80))
  console.log('第一轮 usage:', JSON.stringify(usage?.usage ?? usage ?? null))
  console.log('第一轮 finish:', JSON.stringify(finish?.reason ?? null))

  assert.equal(finish?.reason?.kind, 'stop', `第一轮没有正常结束：${JSON.stringify(finish?.reason)}`)
  assert.ok(text.length > 0, '第一轮没有出字')
  assert.ok(usage, '第一轮没有 usage')

  // ---- 第二轮：带工具 --------------------------------------------------------
  const withTool = await turn({
    messages: [{ role: 'user', content: [{ type: 'text', text: '请查一下北京的天气。' }] }],
    tools: TOOLS,
  })
  const toolFinish = withTool.at(-1)
  const toolChunks = withTool.filter((c) => c.type === 'tool-call' || c.type === 'tool-call-delta')
  console.log('第二轮 finish:', JSON.stringify(toolFinish?.reason ?? null))
  console.log('第二轮工具块:', toolChunks.length)
  assert.equal(toolFinish?.reason?.kind, 'tool-calls', `第二轮没有产生工具调用：${JSON.stringify(toolFinish?.reason)}`)
  assert.ok(toolChunks.length > 0, '第二轮没有工具调用块')

  // ---- 第三轮：多轮上下文（把上一轮的工具结果喂回去）-------------------------
  const multi = await turn({
    messages: [
      { role: 'user', content: [{ type: 'text', text: '请查一下北京的天气。' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        // 内核对 assistant 消息会读 source.replayState（agent-loop 才会写），
        // 手搓的消息必须补一个 source，否则内核自己就抛 TypeError。
        source: { kind: 'model', provider: PROVIDER_ID, model: 'minimax-agent' },
        toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: '北京' } }],
      },
      { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '北京：晴，26℃' }] },
      { role: 'user', content: [{ type: 'text', text: '那适合出门吗？一句话。' }] },
    ],
  })
  const multiText = multi.filter((c) => c.type === 'text-delta').map((c) => c.text ?? c.delta ?? '').join('')
  console.log('第三轮正文:', multiText.slice(0, 80))
  assert.equal(multi.at(-1)?.reason?.kind, 'stop', `第三轮没有正常结束：${JSON.stringify(multi.at(-1)?.reason)}`)
  assert.ok(multiText.length > 0, '第三轮没有出字')

  console.log('✅ 真实 DSH 内核整轮回归通过（出字 + 工具调用 + 多轮上下文 + usage）')
} finally {
  await ctx.stop?.()
}
