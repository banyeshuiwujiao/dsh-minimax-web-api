import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 真实宿主装配回归：把**运行时镜像**里的插件模块交给真实的 Cordis Context，
 * 验证 apply() 之后 provider 出现在 llm 注册表里、且模型目录能被内核列出。
 *
 * 为什么不用源码目录的模块：真正被客户端加载的是
 * `~/.dsh/profiles/desktop/node_modules/dsh-minimax-web-api`。
 * 源码测试全绿但镜像漏拷一个 lib/*.js，是这套插件历史上真实发生过的故障形态，
 * 所以这里刻意从镜像 import。
 *
 * 不联网、不起后端：autoStart 关闭，只验装配形状。
 */

// 两处 node_modules 分工不同：cordis / dsh-llm 在**共享层** profiles/node_modules，
// 插件本体在 desktop 层的 node_modules。混用会得到 ERR_MODULE_NOT_FOUND——
// 真机上就是这么卡住过一次。
const sharedModules = join(homedir(), '.dsh', 'profiles', 'node_modules')
const desktopModules = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules')
const loadShared = (rel) => import(pathToFileURL(join(sharedModules, rel)).href)
const loadDesktop = (rel) => import(pathToFileURL(join(desktopModules, rel)).href)

const { Context } = await loadShared('@deepseek-ai/cordis/lib/index.js')
const { LlmRuntime } = await loadShared('@deepseek-ai/dsh-llm/lib/index.js')
const plugin = await loadDesktop('dsh-minimax-web-api/lib/provider.js')

assert.equal(typeof plugin.apply, 'function', '镜像里的模块必须导出 apply')
assert.equal(typeof plugin.name, 'string', '插件必须有 name（cordis 用它做条目 id 之外的标识）')

const ctx = new Context()
await ctx.plugin(LlmRuntime)

try {
  const config = {
    baseUrl: 'http://127.0.0.1:4555',
    autoStart: false,
    maxContextWindow: 512000,
    defaultMaxTokens: 32768,
    healthTtlMs: 0,
  }
  // 真实加载路径：cordis 调 apply(ctx, config)，并把 inject 声明的服务注入进来。
  await ctx.plugin(plugin, config)

  const providers = await ctx.llm.listProviders()
  const ids = providers.map((p) => p.id ?? p.provider ?? p)
  console.log('llm.listProviders():', JSON.stringify(ids))
  assert.ok(ids.includes(plugin.PROVIDER_ID), `provider ${plugin.PROVIDER_ID} 未出现在 llm 注册表`)

  const models = await ctx.llm.listModels(plugin.PROVIDER_ID)
  const modelIds = models.map((m) => m.id)
  console.log('llm.listModels():', JSON.stringify(modelIds))
  assert.deepEqual(modelIds, plugin.KNOWN_MODELS.map((m) => m.id))

  // 真实内核 prepareCall：拿到的元数据必须是本插件申报的那一份。
  const prepared = await ctx.llm.prepareCall({
    provider: plugin.PROVIDER_ID,
    model: 'minimax-m3.1-flash',
  })
  console.log('prepareCall.config:', JSON.stringify(prepared.config))
  assert.equal(prepared.config.model, 'minimax-m3.1-flash')
  assert.equal(typeof prepared.stream, 'function')

  console.log('✅ 运行时镜像插件在真实 Cordis Context 中装配通过')
} finally {
  await ctx.stop?.()
}