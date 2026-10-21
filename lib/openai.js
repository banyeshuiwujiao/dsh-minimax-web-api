/**
 * DSH 词汇与 OpenAI Chat Completions 词汇之间的纯函数转换。
 *
 * 与 dsh-deepseek-web-api/lib/openai.js 同构，但有两处必须不同：
 *   1. 输入支持图片 URL（minimax2api 的 app/model_api.py 会把 image_url 转成
 *      Anthropic 的 image 块；base64 会被当成 url source 发给上游而失败，必须拦下）；
 *   2. 没有"文本工具协议"这回事——上游是 Anthropic Messages 的结构化 tool use，
 *      反代翻成标准 tool_calls，所以不需要 DSML 残留检测。
 *
 * 全部无副作用、可单测；流式编排在 provider.js 里。
 *
 * @module lib/openai.js
 */

/** 上游/反代用来表达"上下文超长"的常见措辞。 */
const CONTEXT_OVERFLOW = /context[\s_-]?(?:length|window)[\s_-]?(?:exceed|overflow|limit)|(?:prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+(?:large|long)|maximum context/i

/**
 * 明确表示"号池里没有可用账号"的措辞。
 * 这不是传输故障：报成 TRANSPORT 会让内核白重试两轮，报 MISSING_CREDENTIAL 才会
 * 直接把"去控制台导账号"这件事摆到用户面前。
 */
const NO_ACCOUNT = /no accounts?\b|no_account|no available account|account pool|not configured; add one|accounts unusable/i

/**
 * 余额/额度耗尽的措辞。
 *
 * 为什么单独认：MiniMax 上游把"余额不足"包成 **HTTP 500**，正文里才藏着
 * `unexpected status code: 402 ... insufficient_balance_error`。
 * 只看 HTTP 状态码的话，这种请求会被判成 SERVER → 进重试列表 → 白等两轮退避，
 * 而它其实是"账号没钱了"，重试一万次也一样。按正文判成 QUOTA 才能立刻把
 * "给账号充值/换号"摆到用户面前。
 */
const QUOTA_EXHAUSTED = /insufficient[_ ]?balance|insufficient balance|余额不足|额度不足|额度耗尽|status code:\s*402|payment required|quota exhausted|out of credit/i

/** 凭据被上游拒绝的措辞（同样可能被包在 5xx 里）。 */
// 上游把凭据被拒包成各种形状："minimax llm HTTP 401"（后端把上游 401 原样抛出）、
// "status code: 401"、401/403 的文字描述。三种都要认出来——
// 凭据被拒是**不可重试**的（重试只会再被拒一次），而且它的真实含义往往是
// "1 小时的 access token 到期了"，需要续期而不是重试。
const CREDENTIAL_REJECTED = /invalid[_ ]?(?:credential|token|password)|token (?:is )?expired|unauthorized|status code:\s*(?:401|403)|\bHTTP\s*(?:401|403)\b|(?:401|403)\s+(?:unauthorized|forbidden)|登录已过期/i

/** 估算 token 数：CJK 按 1 字符 1 token，其余按 4 字符 1 token。 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text === '') return 0
  let wide = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) {
      wide += 1
    }
  }
  return Math.ceil(wide + (text.length - wide) / 4)
}

/** 按真正上线的载荷估算输入 token（system + 历史 + 工具 schema 都算进去）。 */
export function estimateInputTokens(messages, tools) {
  const payload = JSON.stringify({ messages: Array.isArray(messages) ? messages : [], tools: tools ?? [] })
  return estimateTokens(payload)
}

/** 从各种图片 block 形状里取 URL（DSH 的 image / image_url、OpenAI 的 image_url、Anthropic 的 source）。 */
function imageUrlOf(block) {
  if (!block || typeof block !== 'object') return ''
  const direct = block.image_url
  if (typeof direct === 'string') return direct
  if (direct && typeof direct.url === 'string') return direct.url
  if (typeof block.url === 'string') return block.url
  const source = block.source
  if (source && typeof source === 'object' && typeof source.url === 'string') return source.url
  return ''
}

/**
 * 抽出消息里的文本与可转发的图片 URL，并报告被丢弃的 block 类型。
 *
 * 被丢弃的必须显式告警：静默变空串会让模型"看不见图却照样回答"，
 * 而调用方以为图已经传过去了。
 *
 * @param {unknown} content
 * @returns {{ text: string, images: string[], skipped: string[] }}
 */
export function collectContent(content) {
  if (typeof content === 'string') return { text: content.trim(), images: [], skipped: [] }
  if (!Array.isArray(content)) return { text: '', images: [], skipped: [] }
  const parts = []
  const images = []
  const skipped = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    const type = typeof block?.type === 'string' ? block.type : 'unknown'
    if (type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    if (type === 'image' || type === 'image_url' || type === 'input_image') {
      const url = imageUrlOf(block)
      // 反代只把 http(s) URL 作为 image source 转发；data: URL 会让上游拒绝。
      if (/^https?:\/\//i.test(url)) {
        images.push(url)
      } else if (!skipped.includes('image(非URL)')) {
        skipped.push('image(非URL)')
      }
      continue
    }
    if (!skipped.includes(type)) skipped.push(type)
  }
  return { text: parts.join('\n').trim(), images, skipped }
}

/** 兼容旧签名：只要文本。 */
export function textOf(content) {
  return collectContent(content).text
}

/**
 * DSH 消息历史 → OpenAI messages。
 *
 * system/developer 一律透传（反代会把它们拼进 Anthropic 的 system 字段）；
 * 未知角色告警后跳过，不再无声吞掉。
 *
 * @param {{ system?: string, messages?: unknown[] }} options
 * @param {(message: string) => void} [warn]
 */
export function formatOpenAiMessages(options, warn) {
  const messages = []
  const system = typeof options?.system === 'string' ? options.system.trim() : ''
  if (system !== '') messages.push({ role: 'system', content: system })

  const list = Array.isArray(options?.messages) ? options.messages : []
  let callSeq = 0
  for (const msg of list) {
    const role = String(msg?.role || '')
    const { text, images, skipped } = collectContent(msg?.content)
    if (skipped.length > 0) {
      warn?.(`消息中的 ${skipped.join('/')} 内容无法经 MiniMax 反代转发，已丢弃（图片需为 http(s) URL）`)
    }

    if (role === 'system' || role === 'developer') {
      if (text !== '') messages.push({ role: 'system', content: text })
      continue
    }
    if (role === 'user') {
      if (images.length === 0) {
        messages.push({ role: 'user', content: text })
      } else {
        const blocks = []
        if (text !== '') blocks.push({ type: 'text', text })
        for (const url of images) blocks.push({ type: 'image_url', image_url: { url } })
        messages.push({ role: 'user', content: blocks })
      }
      continue
    }
    if (role === 'assistant') {
      const item = { role: 'assistant', content: text }
      const calls = Array.isArray(msg?.toolCalls) ? msg.toolCalls : []
      if (calls.length > 0) {
        item.tool_calls = calls.map((tc) => {
          callSeq += 1
          const id = typeof tc?.id === 'string' && tc.id !== '' ? tc.id : `call_dsh_${callSeq}`
          return {
            id,
            type: 'function',
            function: {
              name: String(tc?.name || ''),
              arguments: typeof tc?.arguments === 'string' ? tc.arguments : JSON.stringify(tc?.arguments ?? {}),
            },
          }
        })
      }
      messages.push(item)
      continue
    }
    if (role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: String(msg?.toolCallId || msg?.id || 'call_0'),
        content: text,
      })
      continue
    }
    warn?.(`未知消息角色 "${role || '(空)'}" 已跳过`)
  }
  return messages
}

/** 描述裁剪：默认 0 = 不裁剪（反代把 schema 原样转给上游，砍掉的就是模型看不到的）。 */
export function clampDescription(text, maxChars) {
  const max = Number(maxChars)
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/** DSH tools → OpenAI function tools。 */
export function formatOpenAiTools(tools, maxDescriptionChars = 0) {
  const list = Array.isArray(tools) ? tools : []
  if (list.length === 0) return undefined
  return list.map((t) => ({
    type: 'function',
    function: {
      name: String(t?.name || ''),
      description: clampDescription(String(t?.description || ''), maxDescriptionChars),
      parameters: t?.parameters || { type: 'object', properties: {} },
    },
  }))
}

/**
 * HTTP 状态码 → 内核的稳定错误码词汇（与 llm-pi-ai 适配器一致）：
 * AUTH(401/403)、QUOTA(402)、RATE_LIMIT(429)、CONTEXT_WINDOW_EXCEEDED、
 * INVALID_REQUEST(400/413/422)、SERVER(5xx)、其余 HTTP_<status>。
 * 只有可重试码才该进 retryableCodes。
 */
export function failureCodeForStatus(status, detail = '') {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 402) return 'QUOTA'
  if (status === 429) return 'RATE_LIMIT'
  if (CONTEXT_OVERFLOW.test(detail)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (status === 400 || status === 413 || status === 422) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * 流内错误帧/异常文本 → 内核错误码；认不出时返回空串交给调用方兜底。
 *
 * minimax2api 在"号池为空"时先回 HTTP 200 再吐一帧 `{"error": {...}}`，
 * 所以错误码不能只看 HTTP 状态。
 */
export function failureCodeForMessage(message) {
  const text = typeof message === 'string' ? message : ''
  if (NO_ACCOUNT.test(text)) return 'MISSING_CREDENTIAL'
  if (QUOTA_EXHAUSTED.test(text)) return 'QUOTA'
  if (CREDENTIAL_REJECTED.test(text)) return 'AUTH'
  if (CONTEXT_OVERFLOW.test(text)) return 'CONTEXT_WINDOW_EXCEEDED'
  return ''
}

/** 解析 Retry-After（秒数或 HTTP 日期）为毫秒，拿不到就 undefined。 */
export function retryAfterMs(headerValue) {
  const raw = typeof headerValue === 'string' ? headerValue.trim() : ''
  if (raw === '') return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const at = Date.parse(raw)
  if (Number.isFinite(at)) return Math.max(0, at - Date.now())
  return undefined
}

/** 从错误响应体里尽量取出人类可读的 message。 */
export function describeErrorBody(status, rawBody) {
  const text = typeof rawBody === 'string' ? rawBody.trim() : ''
  let message = `HTTP ${status}${text ? `: ${text}` : ''}`
  try {
    const parsed = JSON.parse(text)
    const candidate = parsed?.error?.message ?? parsed?.message
    if (typeof candidate === 'string' && candidate !== '') message = candidate
  } catch {
    // 非 JSON 响应体，沿用状态行
  }
  return { message, detail: text }
}