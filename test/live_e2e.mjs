import assert from 'node:assert/strict'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { MiniMaxWebApiAdapter } from '../lib/provider.js'

/**
 * 真实端到端：插件 → minimax2api → MiniMax 上游 → 插件。
 *
 * 与 smoke 的区别：smoke 用假 fetch 打桩，**这个脚本打的是真的 HTTP**，
 * 所以它验的是整条链路（协议转换、SSE 解析、真实 usage、真实工具调用），
 * 前提是本机 4555 上有可用账号的 minimax2api。
 *
 * 跑之前先看后端：
 *   curl http://127.0.0.1:4555/health     # status=ok, usableAccounts>=1
 *
 * 用法：
 *   node test/live_e2e.mjs                  # 默认模型 + 工具调用
 *   node test/live_e2e.mjs minimax-agent   # 指定模型（目前目录里只有这一个）
 */

const model = process.argv[2] || 'minimax-agent'
const baseUrl = 'http://127.0.0.1:4555'

// 先探活：号池空时给出可操作的提示，而不是让后面每个断言都失败。
const health = await fetch(`${baseUrl}/health`).then((r) => r.json()).catch(() => null)
if (!health) {
  console.error('❌ 后端没起：先在 git-repo/minimax2api 里跑 python run.py --port 4555')
  process.exit(2)
}
if (health.usableAccounts < 1) {
  console.error(`❌ 号池为空（accounts=${health.accounts}）：先在 ${baseUrl}/admin 导入账号`)
  process.exit(2)
}
console.log(`后端就绪: status=${health.status} accounts=${health.accounts} usable=${health.usableAccounts}`)

const adapter = new MiniMaxWebApiAdapter({ baseUrl, autoStart: false }, null, {
  warn: (m) => console.log('  WARN', m),
  debug: (m) => console.log('  DEBUG', m),
})

/** 跑一轮并把 chunk 收齐。 */
async function run(label, options) {
  console.log(`\n=== ${label} (${model}) ===`)
  const chunks = []
  const started = Date.now()
  for await (const chunk of adapter.stream(model, options, { ...adapter.current(), autoStart: false }, adapter.ensureManager())) {
    chunks.push(chunk)
  }
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  const calls = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
  const usage = chunks.find((c) => c.type === 'usage')
  const finish = chunks.find((c) => c.type === 'finish')
  console.log(`  耗时 ${Date.now() - started}ms  finish=${JSON.stringify(finish?.reason)}`)
  if (reasoning) console.log(`  思考(${reasoning.length}字): ${reasoning.slice(0, 120)}…`)
  if (text) console.log(`  正文(${text.length}字): ${text.slice(0, 300)}`)
  if (calls.length) {
    console.log(`  工具调用 ${calls.length} 个:`)
    for (const call of calls) console.log(`    - ${call.block.name}(${String(call.block.arguments).slice(0, 120)})`)
  }
  if (usage) console.log(`  usage: ${JSON.stringify(usage.usage)}`)
  return { chunks, text, reasoning, calls, usage, finish }
}

// 1) 普通对话：验证真实出字 + 真实 usage
const plain = await run('普通对话', {
  system: '你是一个简短作答的助手。',
  messages: [{ role: 'user', content: '用一句话说明什么是向量数据库。' }],
  maxTokens: 1024,
})

// 环境未就绪（账号余额不足/凭据失效）不是插件的错，但错误码必须是对的：
// 余额不足必须是 QUOTA（不可重试），而不是掉进 SERVER/TRANSPORT 白等两轮退避。
if (plain.finish?.reason?.kind === 'error') {
  const code = plain.finish.reason.failure?.code
  assert.ok(
    ['QUOTA', 'AUTH', 'MISSING_CREDENTIAL'].includes(code),
    `失败应被判成不可重试的 QUOTA/AUTH/MISSING_CREDENTIAL，实际 ${code}：${plain.finish.reason.failure?.message}`,
  )
  console.log(`\n⚠ 环境未就绪（code=${code}）：${plain.finish.reason.failure?.message}`)
  console.log('   链路本身是通的（请求已到上游并带回了上游的真实报错），补齐条件后重跑本脚本即可。')
  process.exit(3)
}

assert.ok(plain.text.length > 0, '正文不能为空')
assert.equal(plain.finish.reason.kind, 'stop', `finish 应该是 stop，实际 ${JSON.stringify(plain.finish.reason)}`)
assert.ok(plain.usage?.usage?.outputTokens > 0, '应拿到真实 outputTokens')

// 2) 工具调用：验证 tool_calls 真的从上游回来了
const withTool = await run('工具调用', {
  system: '需要查询天气时必须调用工具，不要自己编造数据。',
  messages: [{ role: 'user', content: '北京今天天气怎么样？' }],
  tools: [
    {
      name: 'get_weather',
      description: '查询某个城市的当前天气',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市名' } },
        required: ['city'],
      },
    },
  ],
  maxTokens: 2048,
})
assert.ok(withTool.calls.length > 0, '应当拿到至少一个 tool_call')
assert.equal(withTool.calls[0].block.name, 'get_weather')
assert.ok(JSON.parse(withTool.calls[0].block.arguments).city, '工具参数应含 city')

console.log('\n✅ live e2e 全部通过：真实出字 + 真实工具调用 + 真实 usage')
