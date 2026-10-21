import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { PROVIDER_ID, MiniMaxWebApiAdapter } from '../lib/provider.js'

/**
 * 真实 DSH LlmRuntime 集成回归：验证本适配器在宿主里能被 prepareCall 正常装配。
 *
 * 不联网、不起后端（autoStart: false）：这里验的是**契约形状**——内核要的
 * `{ model, stream }` 是否齐备、模型元数据是否被内核接受。真实出字由人工验收。
 */

const llmRoot = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-llm')
const imp = (rel) => import(pathToFileURL(join(llmRoot, rel)).href)
const { LlmRuntime } = await imp('lib/index.js')
const cordisRoot = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'cordis')
const { Context } = await import(pathToFileURL(join(cordisRoot, 'lib', 'index.js')).href)

async function withRuntime(fn) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  try {
    return await fn(ctx)
  } finally {
    await ctx.stop?.()
  }
}

await withRuntime(async (ctx) => {
  const adapter = new MiniMaxWebApiAdapter({
    baseUrl: 'http://127.0.0.1:4555',
    autoStart: false,
  })
  ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  const prepared = await ctx.llm.prepareCall({ provider: PROVIDER_ID, model: 'minimax-m3.1-flash' })
  console.log('真实 DSH LlmRuntime prepareCall 结果:', JSON.stringify({
    config: prepared.config,
    hasStream: typeof prepared.stream === 'function',
  }))
  assert.equal(typeof prepared.stream, 'function')
  assert.equal(prepared.config.model, 'minimax-m3.1-flash')
  console.log('✅ 真实 DSH LlmRuntime 集成回归通过')
})