/**
 * DSH 的图片块 → 反代能吃的 image_url。
 *
 * 为什么需要这一层：内核给适配器的图片**不是 URL**，而是一个持久引用——
 *
 *   { type: 'image', attachment: { attachmentId, name?, mediaType, width, height, bytes } }
 *
 * 真正的字节要去**挂载的 attachment 服务**里取（`ctx.attachments.readImageRequest`），
 * 取回来的请求版本才是可发的数据。适配器不取这一步，模型就永远看不见这张图，
 * 而且是**静默**地看不见：用户贴了图、模型看不见却照样答得头头是道。
 *
 * 反代（minimax2api）这一侧只认 OpenAI 的 `image_url`，而它的 Anthropic 转换
 * （app/model_api.py）会把 `image_url` 原样变成 Anthropic 的 image 块；
 * `data:` URL 实测上游照单全收（见 README「视觉读图」一节）。
 *
 * 全部无副作用、可单测。
 *
 * @module lib/images.js
 */

/** 已经是能直接转发的 URL 形状：http(s) 与 data:。 */
export function isForwardableUrl(url) {
  return typeof url === 'string' && (/^https?:\/\//i.test(url) || /^data:/i.test(url))
}

/**
 * 取出一个块里的持久图片引用（DSH 原生形状）。
 *
 * 只有内核的 ImageBlock 才有 `attachment`；OpenAI 形状的 image_url 块没有，
 * 所以两者能并存而不互相误认。
 *
 * @param {unknown} block
 * @returns {object | null} 持久引用，取不到就是 null
 */
export function attachmentRefOf(block) {
  const attachment = block?.attachment
  if (!attachment || typeof attachment !== 'object') return null
  if (typeof attachment.attachmentId !== 'string' || attachment.attachmentId === '') return null
  return attachment
}

/**
 * 请求版本 → data: URL。
 *
 * `readImageRequest` 返回的 `data` 是 Uint8Array；已经是 base64 字符串时直接用。
 *
 * @param {{ mediaType?: string, data?: Uint8Array | string }} version
 * @returns {string}
 */
export function imageDataUrl(version) {
  const mediaType = typeof version?.mediaType === 'string' && version.mediaType !== ''
    ? version.mediaType
    : 'image/png'
  const raw = version?.data
  const base64 = typeof raw === 'string' ? raw : Buffer.from(raw ?? []).toString('base64')
  return `data:${mediaType};base64,${base64}`
}

/**
 * 模型能看见的图片句柄（对齐内核 `requestImageHandleText` 的口径）。
 *
 * 有了它，模型才能在回答里指认"第二张图"；只有像素没有句柄时模型只能说"图里"。
 *
 * @param {object} ref 持久引用
 * @param {{ width?: number, height?: number }} version 请求版本
 * @returns {string}
 */
export function imageHandleText(ref, version) {
  const name = ref?.name
  const identity = name === undefined
    ? String(ref?.attachmentId ?? '')
    : `${JSON.stringify(name)} (${ref.attachmentId})`
  const width = version?.width ?? ref?.width
  const height = version?.height ?? ref?.height
  return `Image ${identity}; request preview ${width}x${height}px.`
}

/**
 * 把消息里的持久图片块换成可转发的 image_url 块。
 *
 * 每个图片块换成「一句句柄 + 一个 image_url」，句柄在前是为了让模型能按顺序指认。
 * 解析失败的图片换成一句说明文字而不是静默消失——模型至少知道"这里本来有张图"。
 *
 * @param {unknown[]} messages DSH 消息
 * @param {(ref: object) => Promise<object>} resolve 引用 → 请求版本
 * @returns {Promise<{ messages: unknown[], resolved: number, failed: number }>}
 */
export async function resolveMessageImages(messages, resolve) {
  const list = Array.isArray(messages) ? messages : []
  let resolved = 0
  let failed = 0
  const out = []
  for (const message of list) {
    const content = message?.content
    if (!Array.isArray(content)) {
      out.push(message)
      continue
    }
    let changed = false
    const blocks = []
    for (const block of content) {
      const ref = attachmentRefOf(block)
      if (ref === null) {
        blocks.push(block)
        continue
      }
      changed = true
      try {
        const version = await resolve(ref)
        blocks.push({ type: 'text', text: imageHandleText(ref, version) })
        blocks.push({ type: 'image_url', image_url: { url: imageDataUrl(version) } })
        resolved += 1
      } catch (error) {
        failed += 1
        blocks.push({
          type: 'text',
          text: `[image omitted because it could not be read: ${ref.attachmentId}]`,
        })
      }
    }
    out.push(changed ? { ...message, content: blocks } : message)
  }
  return { messages: out, resolved, failed }
}
