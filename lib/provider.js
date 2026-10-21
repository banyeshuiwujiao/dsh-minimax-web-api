// dsh-minimax-web-api —— 把 minimax2api（minimaxcode2api）反代接入 DSH 模型选择器。
//
// 架构（与 dsh-deepseek-web-api 同构，差异在“上游是谁”）：
//   1. 模型选择器的数据源 = ctx.llm.listProviders() × listModels()；
//   2. 插件注册为 provider 路由（ctx.llm.registerAdapter），不注册为工具；
//   3. autoStart 时自动拉起 Python 后端（python run.py --port 4555），dispose 按进程树回收；
//   4. 完整实现 OpenAI Chat Completions SSE 增量到 DSH StreamChunk 的映射：
//      reasoning_content → reasoning-delta（思考气泡）、content → text-delta、
//      tool_calls → 累积后整块下发。
//
// 为什么不需要 DSML/文本协议解析：minimax2api 的上游是 Anthropic Messages
// （结构化 tool use），反代在 app/model_api.py 里把 tool_use 翻成标准 OpenAI
// tool_calls，不经过“把工具定义塞进提示词再解析文本”的黑盒链路。
//
// 分工：本文件只做流式编排；纯函数转换在 lib/openai.js，内核归因头在 lib/kernel.js，
// Python 进程托管在 lib/server.js。

import { resolveAttributionHeaders } from './kernel.js'
import {
  clampDescription,
  describeErrorBody,
  estimateInputTokens,
  estimateTokens,
  failureCodeForMessage,
  failureCodeForStatus,
  formatOpenAiMessages,
  formatOpenAiTools,
  retryAfterMs,
  textOf,
} from './openai.js'
import { createBackendManager } from './server.js'

export const name = 'dsh-minimax-web-api-provider'
export const inject = ['llm']

/** provider 路由 id（模型选择器中展示的分组）。 */
export const PROVIDER_ID = 'minimax-web-api'
export const PROVIDER_LABEL = 'MiniMax Agent (反代)'

/**
 * 模型目录。
 *
 * id 必须与后端 app/records.py 的 builtin_models() 一致：反代按 id 查目录、
 * 拒绝未知模型（不会静默替换），写错名字的代价是“模型能选但一调就 400”。
 * minimax-image 是图像生成模型，不是对话模型，刻意不列进来（会走 DSH 的对话链路）。
 */
export const KNOWN_MODELS = [
  {
    id: 'minimax-agent',
    name: 'MiniMax Agent · M3.1 Flash（默认）',
    description: '号池默认对话模型，上游 MiniMax-M3.1-Flash；低延迟通用对话',
    thinking: false,
    image: false,
  },
  {
    id: 'minimax-m3.1-flash',
    name: 'MiniMax M3.1 Flash',
    description: '新一代 Flash，512K 上下文（可选 1M），输入支持文本/图片 URL',
    thinking: false,
    image: true,
  },
  {
    id: 'minimax-m3.1-flash-thinking',
    name: 'MiniMax M3.1 Flash Thinking',
    description: 'M3.1 Flash 的深度思考变体，思维链走 reasoning_content 实时流式',
    thinking: true,
    image: true,
  },
  {
    id: 'minimax-m3',
    name: 'MiniMax M3',
    description: 'M3 对话模式，上游 MiniMax-M3，推理可切换',
    thinking: false,
    image: true,
  },
  {
    id: 'minimax-m3-thinking',
    name: 'MiniMax M3 Thinking',
    description: 'M3 深度思考变体，思维链走 reasoning_content',
    thinking: true,
    image: true,
  },
]

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:4555',
  // 后端目录不写死：配置 → 环境变量 DSH_MINIMAX2API_DIR → 指针 ~/.dsh/minimax2api.json
  // → 插件同级 → home 常见位置。详见 lib/paths.js。
  serverDir: '',
  pointerFile: '',
  // Python 解释器：配置 → 环境变量 DSH_MINIMAX2API_PYTHON → 后端 .venv → PATH。
  pythonPath: '',
  // SQLite 与生成媒体的目录；留空 = <serverDir>/data。
  dataDir: '',
  autoStart: true,
  startTimeoutMs: 90000,
  probeTimeoutMs: 3000,
  // M3.1 Flash 标称 512K（可选 1M）。向 DSH 申报 512K，压缩线才不会过于乐观。
  maxContextWindow: 512000,
  // 向 DSH 申报的单轮输出预留；同时作为 max_tokens 发给后端（Anthropic 必填，
  // 后端缺省只有 4096，长参数生成会被截断）。
  defaultMaxTokens: 32768,
  // 0 = 不裁剪工具描述（反代把 schema 原样转给上游，砍掉的就是模型看不到的）。
  toolDescriptionMaxChars: 0,
  // /health 结果缓存：一次多步会话不必每步探活。
  healthTtlMs: 30000,
  // 上游连续无数据的容忍上限，超时按可重试的 TIMEOUT 中止。MiniMax 首个 token
  // （尤其 thinking）可能很慢，默认给到 180s。
  streamIdleTimeoutMs: 180000,
  // 后端子进程输出落盘（>2MB 轮转 .1），事后取证用；留空只留在内存尾部 200 行。
  logFile: '',
  // 托管（默认）：stdio 走管道，dispose 按进程树回收；detach: true 则后端独立存活。
  detach: false,
  killTreeOnDispose: true,
  // 需要透传给后端的额外环境变量名（值仍从本进程环境取）。
  passEnvKeys: [],
  // 直接注入后端的额外环境变量（MINIMAX2API_* 命名空间已默认放行）。
  env: {},
  strictBackend: true,
  requiredCapabilities: [],
  minBackendVersion: '',
}

/** 影响后端进程与探活的配置项：只有这些变了才重建 manager（重建=杀掉旧子进程）。 */
const MANAGER_KEYS = [
  'baseUrl', 'serverDir', 'pointerFile', 'pythonPath', 'dataDir', 'autoStart', 'startTimeoutMs',
  'probeTimeoutMs', 'healthTtlMs', 'logFile', 'detach', 'killTreeOnDispose', 'passEnvKeys', 'env',
  'strictBackend', 'requiredCapabilities', 'minBackendVersion',
]

function managerKeyOf(opts) {
  return MANAGER_KEYS.map((key) => `${key}=${JSON.stringify(opts[key] ?? '')}`).join('\u0000')
}

/** 该模型是否声明了图片输入（只影响向 DSH 申报的模态，不改变请求体）。 */
export function modelSupportsImage(model) {
  return KNOWN_MODELS.find((m) => m.id === model)?.image === true
}

/** 该模型是否是思考变体（仅用于选择器展示与日志）。 */
export function resolveThinkingEnabled(model) {
  const known = KNOWN_MODELS.find((m) => m.id === model)
  if (known) return known.thinking === true
  return /thinking|reasoner|pro/i.test(String(model))
}

/** LlmAdapter 实现。配置按调用时读取，不是一次性快照。 */
export class MiniMaxWebApiAdapter {
  /**
   * @param {object | (() => object)} source 配置对象，或返回配置的函数
   * @param {object | null} manager 预置的后端管理器（测试用）
   * @param {object | null} logger 宿主日志
   */
  constructor(source = {}, manager = null, logger = null) {
    this.source = source
    this.logger = logger || (source && source.logger) || null
    this._manager = manager
    this._managerKey = manager ? managerKeyOf(this._read()) : ''
    this.generation = 0
    this.opts = this._read()
  }

  _read() {
    const raw = typeof this.source === 'function' ? this.source() : this.source
    return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  }

  /** 取当代配置；管理器相关字段变了就回收旧管理器。 */
  current() {
    const opts = this._read()
    const key = managerKeyOf(opts)
    if (this._manager && key !== this._managerKey) {
      try {
        this._manager.dispose()
      } catch {
        // 旧管理器已经坏了也不能挡住新配置生效
      }
      this._manager = null
      this.warn('配置里与后端进程相关的项已变更，重建后端管理器')
    }
    if (!this._manager) this._manager = createBackendManager(opts, this.logger)
    this._managerKey = key
    this.opts = opts
    return opts
  }

  ensureManager() {
    this.current()
    return this._manager
  }

  dispose() {
    try {
      this._manager?.dispose()
    } catch {
      // 已经坏掉的管理器不该让卸载失败
    }
    this._manager = null
    this._managerKey = ''
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_LABEL }
  }

  /**
   * 只把“重试有意义”的码列进来：MISSING_CREDENTIAL/AUTH/INVALID_REQUEST/
   * CONTEXT_WINDOW_EXCEEDED 每次都会以同样方式失败，重试只是白等退避。
   */
  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 1500,
      maxDelayMs: 5000,
      jitterRatio: 0.2,
    }
  }

  async listModels(provider) {
    return KNOWN_MODELS.map((m) => ({
      provider,
      id: m.id,
      name: m.name,
      description: m.description,
      inputModalities: m.image ? ['text', 'image'] : ['text'],
    }))
  }

  async resolveModel(provider, model, opts = this.current()) {
    const matched = KNOWN_MODELS.find((m) => m.id === model)
    const defaultMaxTokens = Number(opts.defaultMaxTokens)
    const contextWindow = Number(opts.maxContextWindow)
    return {
      provider,
      id: model,
      name: matched ? matched.name : `${model} · MiniMax 反代`,
      description: matched ? matched.description : '通过 minimax2api 驱动的 MiniMax Agent 模型',
      inputModalities: matched?.image ? ['text', 'image'] : ['text'],
      context: { contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 512000 },
      ...(Number.isFinite(defaultMaxTokens) && defaultMaxTokens > 0 ? { defaultMaxTokens } : {}),
    }
  }

  /**
   * 客户端 dsh-llm 适配器必需接口：prepareCall(provider, model, signal)。
   * 返回 { model, stream }。每轮开始时读一次当代配置并记世代，
   * 把 stream 绑到这一代上，避免“准备时元数据”和“派发时配置”跨代混用。
   */
  async prepareCall(provider, model, signal) {
    if (signal?.aborted === true) throw new Error('minimax-web-api: request aborted')
    const opts = this.current()
    const manager = this._manager
    this.generation += 1
    return {
      model: await this.resolveModel(provider, model, opts),
      stream: (options) => this.stream(model, options, opts, manager),
    }
  }

  /** 统一告警出口：没有 logger 时退回 console，保证问题不会静默。 */
  warn(message) {
    const text = `minimax-web-api: ${message}`
    if (typeof this.logger?.warn === 'function') this.logger.warn(text)
    else console.warn(text)
  }

  debug(message) {
    const text = `minimax-web-api: ${message}`
    if (typeof this.logger?.debug === 'function') this.logger.debug(text)
  }

  /**
   * 流式生成：把 DSH 的调用转发给 minimax2api 的 POST /v1/chat/completions (SSE)，
   * 并将增量转换为 DSH StreamChunk（reasoning-delta / text-delta / tool-call-delta / usage / finish）。
   */
  async * stream(model, options, boundOpts, boundManager) {
    const opts = boundOpts || this.current()
    const manager = boundManager || this.ensureManager()
    const signal = options?.signal
    if (signal?.aborted === true) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } } }
      return
    }

    try {
      await manager.ensure()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = typeof error?.failureCode === 'string' && error.failureCode !== '' ? error.failureCode : 'TRANSPORT'
      yield { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
      return
    }

    const messages = formatOpenAiMessages(options, (message) => this.warn(message))
    const tools = formatOpenAiTools(options?.tools, opts.toolDescriptionMaxChars)
    // Anthropic Messages 的 max_tokens 是必填项，而 minimax2api 在缺省时只填 4096
    // （见 app/model_api.py：`int(mx) if ... else 4096`）。内核没给预算时若干脆不传，
    // 长文件写入会被上游截在 4096 token——所以这里必须回落到申报的 defaultMaxTokens，
    // 而不是"没给就不传"。两者都没有时才交给后端缺省。
    const fallbackMaxTokens = Number(opts.defaultMaxTokens)
    const requestedMaxTokens = Number(options?.maxTokens)
    const maxTokens = Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
      ? requestedMaxTokens
      : (Number.isFinite(fallbackMaxTokens) && fallbackMaxTokens > 0 ? fallbackMaxTokens : 0)
    const body = {
      model,
      messages,
      stream: true,
      // 反代据此在最后一个 chunk 上挂真实 usage；拿不到时插件才估算兜底。
      stream_options: { include_usage: true },
      ...(tools ? { tools } : {}),
      ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
    }

    const attribution = await resolveAttributionHeaders(this.logger)
    const headers = { ...attribution, 'content-type': 'application/json' }

    let response
    try {
      response = await fetch(`${opts.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      yield { type: 'finish', reason: this.transportFailure(error, signal) }
      return
    }

    if (!response.ok) {
      const rawBody = await response.text().catch(() => '')
      const { message, detail } = describeErrorBody(response.status, rawBody)
      const code = failureCodeForMessage(detail) || failureCodeForStatus(response.status, detail)
      const retryAfter = retryAfterMs(response.headers?.get?.('retry-after'))
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `minimax-web-api 错误: ${message}`,
            code,
            status: response.status,
            ...(retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter }),
          },
        },
      }
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let blockIndex = 0
    let currentBlockType = null // 'reasoning' | 'text' | null
    let reasoningText = ''
    let contentText = ''
    let hasToolCalls = false
    let finishReason = 'stop'
    let sawUsage = false
    let upstreamPromptTokens = 0
    let upstreamCompletionTokens = 0
    let done = false
    const pendingCalls = new Map()
    const startedAt = Date.now()
    let firstDeltaAt = 0

    // 出错、提前 return 时也要把已打开的 block 收尾，否则宿主会渲染一个不闭合的气泡。
    const closeOpenBlock = () => {
      if (!currentBlockType) return null
      const type = currentBlockType
      const text = type === 'reasoning' ? reasoningText : contentText
      const chunk = { type: 'block-end', index: blockIndex, block: { type, text } }
      blockIndex++
      currentBlockType = null
      return chunk
    }

    const idleMs = Number(opts.streamIdleTimeoutMs)
    const readNext = () => {
      if (!Number.isFinite(idleMs) || idleMs <= 0) return reader.read()
      let timer = null
      const idle = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error(`minimax-web-api 流空闲超过 ${idleMs}ms 没有数据`), { failureCode: 'TIMEOUT' }))
        }, idleMs)
      })
      return Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer))
    }

    // 工具调用块统一在收尾时下发：正文/推理先闭合，再逐个给出完整参数。
    function* emitPendingCalls() {
      let seq = 0
      for (const slot of pendingCalls.values()) {
        seq += 1
        const index = blockIndex++
        const id = slot.id || `call_dsh_${Date.now().toString(36)}_${seq}`
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name: slot.name, argumentsDelta: slot.args }
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name: slot.name, arguments: slot.args } }
      }
    }

    /** 每轮一行统计：这类失败过去是静默的，有 ttft 与通道长度才能事后复盘。 */
    const logTurn = (outcome, extra = {}) => {
      const fields = [
        `model=${model}`,
        `ms=${Date.now() - startedAt}`,
        `ttft=${firstDeltaAt === 0 ? 'none' : `${firstDeltaAt - startedAt}ms`}`,
        `reasonChars=${reasoningText.length}`,
        `contentChars=${contentText.length}`,
        `toolCalls=${pendingCalls.size}`,
        `usage=${sawUsage ? `${upstreamPromptTokens}/${upstreamCompletionTokens}` : 'estimated'}`,
        `outcome=${outcome}`,
      ]
      for (const [key, value] of Object.entries(extra)) fields.push(`${key}=${value}`)
      const line = fields.join(' ')
      if (outcome === 'stop' || outcome === 'tool-calls') this.debug(line)
      else this.warn(line)
    }

    try {
      while (!done) {
        const read = await readNext()
        if (read.done) break
        if (signal?.aborted === true) break

        buffer += decoder.decode(read.value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith(':')) continue
          if (trimmed === 'data: [DONE]') {
            done = true
            break
          }
          if (!trimmed.startsWith('data:')) continue

          const jsonStr = trimmed.slice(5).trim()
          let chunkData
          try {
            chunkData = JSON.parse(jsonStr)
          } catch {
            continue
          }

          // 反代在流内报错时给的是 OpenAI 形状的 error 帧（HTTP 仍是 200）。
          if (chunkData?.error) {
            const detail = typeof chunkData.error.message === 'string' ? chunkData.error.message : ''
            const status = Number(chunkData.error.status ?? chunkData.error.code ?? 0)
            const byMessage = failureCodeForMessage(detail)
            const code = byMessage
              || (Number.isInteger(status) && status >= 400 ? failureCodeForStatus(status, detail) : 'TRANSPORT')
            throw Object.assign(new Error(detail || 'Stream error'), {
              failureCode: code,
              failureStatus: Number.isInteger(status) && status >= 400 ? status : undefined,
            })
          }

          const choice = chunkData?.choices?.[0]
          const delta = choice?.delta

          // 1) 深度思考增量
          if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content !== '') {
            if (currentBlockType !== 'reasoning') {
              if (currentBlockType === 'text') {
                yield { type: 'block-end', index: blockIndex, block: { type: 'text', text: contentText } }
                blockIndex++
              }
              yield { type: 'block-start', index: blockIndex, blockType: 'reasoning' }
              currentBlockType = 'reasoning'
            }
            reasoningText += delta.reasoning_content
            if (firstDeltaAt === 0) firstDeltaAt = Date.now()
            yield { type: 'reasoning-delta', index: blockIndex, text: delta.reasoning_content }
          }

          // 2) 正文增量
          if (typeof delta?.content === 'string' && delta.content !== '') {
            if (currentBlockType === 'reasoning') {
              yield { type: 'block-end', index: blockIndex, block: { type: 'reasoning', text: reasoningText } }
              blockIndex++
              currentBlockType = null
            }
            if (currentBlockType !== 'text') {
              yield { type: 'block-start', index: blockIndex, blockType: 'text' }
              currentBlockType = 'text'
            }
            contentText += delta.content
            if (firstDeltaAt === 0) firstDeltaAt = Date.now()
            yield { type: 'text-delta', index: blockIndex, text: delta.content }
          }

          // 3) 工具调用增量：按 index 累积，收尾时整块下发。
          //    反代目前在 content_block_stop 时给完整调用；若上游改成标准分片
          //    （同 index 多次追加 arguments），这里也能合成一个完整块。
          if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
            hasToolCalls = true
            for (const tc of delta.tool_calls) {
              const key = Number.isInteger(tc?.index) ? tc.index : pendingCalls.size
              const slot = pendingCalls.get(key) || { id: '', name: '', args: '' }
              if (typeof tc?.id === 'string' && tc.id !== '') slot.id = tc.id
              if (typeof tc?.function?.name === 'string') slot.name += tc.function.name
              if (typeof tc?.function?.arguments === 'string') slot.args += tc.function.arguments
              pendingCalls.set(key, slot)
            }
          }

          if (choice?.finish_reason) finishReason = choice.finish_reason

          // usage 只记录不立即下发：内核会把多个 usage 块相加，重复发就是重复计费。
          if (chunkData?.usage && typeof chunkData.usage === 'object') {
            sawUsage = true
            upstreamPromptTokens = Number(chunkData.usage.prompt_tokens) || 0
            upstreamCompletionTokens = Number(chunkData.usage.completion_tokens ?? chunkData.usage.total_tokens) || 0
          }
        }
      }

      const closing = closeOpenBlock()
      if (closing) yield closing
      yield* emitPendingCalls()

      // 输入 token 用反代折算后的真实值（含 cache_read/cache_creation）；
      // 拿不到时才按真正上线的载荷估算，绝不发 0 让宿主误判水位。
      const outputTokens = sawUsage && upstreamCompletionTokens > 0
        ? upstreamCompletionTokens
        : estimateTokens(contentText) + estimateTokens(reasoningText)
      const inputTokens = sawUsage && upstreamPromptTokens > 0
        ? upstreamPromptTokens
        : estimateInputTokens(messages, tools)
      yield { type: 'usage', usage: { inputTokens, outputTokens } }

      // 兜底：整轮什么都没产出时不能静默 stop——那会让 DSH 把回合判成“已完成”。
      if (!hasToolCalls && contentText.trim() === '' && reasoningText.trim() === '') {
        logTurn('EMPTY_RESPONSE')
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: 'minimax-web-api 这一轮没有产出任何内容（检查号池余额/账号状态与后端日志）', code: 'EMPTY_RESPONSE' },
          },
        }
        return
      }

      const outcome = hasToolCalls || finishReason === 'tool_calls' ? 'tool-calls' : 'stop'
      logTurn(outcome)
      yield { type: 'finish', reason: { kind: outcome } }
    } catch (error) {
      const closing = closeOpenBlock()
      if (closing) yield closing
      const reason = this.transportFailure(error, signal)
      logTurn(reason.kind === 'aborted' ? 'aborted' : reason.failure.code)
      yield { type: 'finish', reason }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // 流可能已经结束，忽略
      }
    }
  }

  /** 传输层失败归一：用户中止必须是 ABORTED（不可重试），不能被当成 TRANSPORT 再重试两轮。 */
  transportFailure(error, signal) {
    const message = error instanceof Error ? error.message : String(error)
    if (signal?.aborted === true || error?.name === 'AbortError') {
      return { kind: 'aborted', failure: { message: message || 'request aborted', code: 'ABORTED' } }
    }
    const byMessage = failureCodeForMessage(message)
    const code = byMessage
      || (typeof error?.failureCode === 'string' && error.failureCode !== '' ? error.failureCode : 'TRANSPORT')
    const status = Number.isInteger(error?.failureStatus) ? error.failureStatus : undefined
    const isIdle = /timeout|timed out|idle/i.test(message)
    const finalCode = code === 'TRANSPORT' && isIdle ? 'TIMEOUT' : code
    return {
      kind: 'error',
      failure: {
        message: `${message}${HINTS[finalCode] ? `（${HINTS[finalCode]}）` : ''}`,
        code: finalCode,
        ...(status === undefined ? {} : { status }),
      },
    }
  }
}

/**
 * 错误码 → 一句"下一步做什么"。
 *
 * 上游的原始报错对用户没有可操作性：它会告诉你"余额不足"，却不会告诉你
 * 接下来该去找谁充值。这里把每类不可重试的失败翻译成动作。
 */
const HINTS = Object.freeze({
  QUOTA: 'MiniMax 账号余额不足：给该账号充值，或在 http://127.0.0.1:4555/admin 换一个账号',
  AUTH: 'MiniMax 凭据被拒：重新登录该账号（http://127.0.0.1:4555/admin 的"号池"里重新授权）',
  MISSING_CREDENTIAL: 'minimax2api 号池里没有可用账号：打开 http://127.0.0.1:4555/admin 导入或授权一个',
  CONTEXT_WINDOW_EXCEEDED: '上下文超长：减少历史消息或文件片段',
})

/** 宿主插件入口：注册 provider 路由 + 可配置 provider 条目。 */
export function apply(ctx, config) {
  const logger = ctx?.logger || null
  const source = () => (config && typeof config === 'object' ? config : {})
  const adapter = new MiniMaxWebApiAdapter(source, null, logger)

  const registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter)

  ctx.llm.registerConfigurableProviders?.([
    {
      provider: PROVIDER_ID,
      displayName: PROVIDER_LABEL,
      settingsNs: 'minimax-web-api',
      settingsPath: ['providers', PROVIDER_ID],
    },
  ])

  ctx.on?.('dispose', () => {
    try {
      if (typeof registration === 'function') registration()
    } catch {
      /* ignore */
    }
    adapter.dispose()
  })

  return adapter
}

// 纯函数再从入口导出一遍，兼容既有 import 路径与 smoke 用例。
export {
  clampDescription,
  describeErrorBody,
  estimateInputTokens,
  estimateTokens,
  failureCodeForMessage,
  failureCodeForStatus,
  formatOpenAiMessages,
  formatOpenAiTools,
  retryAfterMs,
  textOf,
}
export { DEFAULTS }