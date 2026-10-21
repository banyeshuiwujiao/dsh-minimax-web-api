/**
 * 插件对 minimax2api 后端的契约校验。
 *
 * 与 deepseek-web-api 不同，这个后端**不提供 capabilities/version 自述**：
 * `/health` 只有 `{status, accounts, usableAccounts, signinEnabled, upstream, time}`。
 * 所以这里不能照抄"能力清单必须齐全"的硬门槛，否则每一台机器都会被判成旧构建。
 *
 * 能判定的最小事实只有一条：`/health` 必须是一个带 `status` 字符串的 JSON 对象。
 * 账号数为 0 属于**运行状态**而不是契约失败——后端起来了、只是还没导入账号，
 * 这时应当让请求走正常路径拿到明确错误，而不是拒绝复用整个后端。
 *
 * @module lib/contract.js
 */

/** 本插件依赖、且缺了会退回旧故障形态的能力（minimax2api 目前不自述，留空）。 */
export const REQUIRED_CAPABILITIES = Object.freeze([])

/** 引入能力自述的版本；minimax2api 没有版本字段，故为空。 */
export const MIN_BACKEND_VERSION = ''

/** 解析 `x.y.z`；不合法返回 null。 */
export function parseVersion(raw) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(raw || '').trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** a < b 返回 -1，相等 0，大于 1；任一边不合法返回 null（表示"无法比较"）。 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

/**
 * 校验一次 `/health` 是否像 minimax2api。
 * @param {object|null} health
 * @param {{ requiredCapabilities?: string[], minBackendVersion?: string }} [opts]
 * @returns {{ ok: boolean, problems: string[], unknown: boolean }}
 */
export function checkContract(health, opts = {}) {
  if (!health || typeof health !== 'object') {
    return { ok: false, unknown: true, problems: ['后端 /health 没有返回 JSON 对象（不是 minimax2api，或服务没起在该端口）'] }
  }

  const problems = []
  if (typeof health.status !== 'string' || health.status === '') {
    problems.push('/health 缺少 status 字段：这个端口上跑的多半不是 minimax2api')
  }

  // 能力清单是可选的：后端现在不自述；将来加了就按配置精确校验。
  const required = Array.isArray(opts.requiredCapabilities) ? opts.requiredCapabilities : []
  const capabilities = Array.isArray(health.capabilities) ? health.capabilities : []
  for (const capability of required) {
    if (!capabilities.includes(capability)) problems.push(`后端缺少能力 ${capability}`)
  }

  if (opts.minBackendVersion) {
    const order = compareVersions(health.version, opts.minBackendVersion)
    if (order === null) problems.push(`后端 version 无法解析: ${JSON.stringify(health.version)}`)
    else if (order < 0) problems.push(`后端版本 ${health.version} 低于本插件要求的 ${opts.minBackendVersion}`)
  }

  return { ok: problems.length === 0, problems, unknown: false }
}

/** 拒用不匹配后端时的报错文本：必须同时给出"发生了什么"和"下一步敲什么命令"。 */
export function contractError(dirHint, problems) {
  return [
    'minimax2api 后端不满足本插件的最小契约，已拒绝复用（避免把别的服务当成反代）。',
    `缺失项：${problems.join('；')}`,
    dirHint ? `后端目录：${dirHint}` : '',
    '处理：在该目录执行 .\\install.ps1（或手动 pip install -r requirements.txt 后 python run.py --port 4555）；' +
      '或把 strictBackend 设为 false 强行复用（不推荐）。',
  ].filter(Boolean).join('\n')
}