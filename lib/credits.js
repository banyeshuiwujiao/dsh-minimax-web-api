// 号池保活 —— 跟着 DSH 客户端的生命周期走。
//
// 为什么放在插件里：
//   插件是随 DSH 客户端一起加载的，所以"客户端开着"就能保证：
//     · **v2rayN 出海规则**：海外号要靠那条按域名的代理规则才不被 Akamai 307
//       跳国内站；规则住在可切换的路由预设里，换预设就没了 → 每轮自愈一次。
//     · **token 续期**：每 30 分钟一次（token 只有 1 小时有效期）
//     · **每日积分**：当天领过就跳过（国内站、海外站都领）
//
//   （以前还有一个 Windows 计划任务做同样的事，2026-10-23 已删除：它只是墙钟触发，
//    客户端整天不开时本来也用不了 MiniMax，而它承担的自愈动作已搬进这里的轮次。）
//
// 为什么必须自己做续期（2026-10-21 的真实事故）：
//   MiniMax 的 access token 只活 1 小时。后端自带 keepalive 会在到期前续，但实测：
//     1) 401 触发的"请求路径续期"不复位账号状态 → 账号被"退休"成 invalid；
//     2) keepalive 的 sweep 只在 token 快到期时才动手 → 刚被退休的账号不满足
//        "快到期"条件 → 号池一直空着，所有请求都报 accounts unusable，
//        直到下一个续期窗口（实测整整一小时）。
//   所以这里主动续期并复位：scripts/keep_tokens_alive.py 复用后端自己的
//   Keeper.renew_account（成功即把 status 复位成 active）。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 状态文件：记下每天领取的结果，避免同一天重复跑积分脚本。 */
export const DEFAULT_STATE_FILE = '~/.dsh/minimax-web-api/claim-state.json'
/**
 * 复查间隔：30 分钟。
 * token 有效期 1 小时、脚本内部按"剩余 ≤20 分钟"才续，所以 30 分钟一轮既够用
 * 又不至于频繁打上游。
 */
export const DEFAULT_INTERVAL_MS = 30 * 60 * 1000
/** 单次脚本的硬超时：上游卡住时不能一直占着（实测遇到过 13 分钟的挂起）。 */
export const DEFAULT_TIMEOUT_MS = 120 * 1000
export const SCRIPT_NAME = 'claim_daily_credits.py'
export const RENEW_SCRIPT_NAME = 'keep_tokens_alive.py'
export const PROXY_SCRIPT_NAME = 'ensure_v2rayn_minimax_proxy.py'
export const ENV_SERVER_DIR = 'MINIMAX2API_DIR'

/** 插件根目录（lib/ 的上一级）。 */
export function pluginDirOf(here = dirname(fileURLToPath(import.meta.url))) {
  return join(here, '..')
}

/** 每日积分脚本的绝对路径。 */
export function scriptPathOf(pluginDir = pluginDirOf()) {
  return join(pluginDir, 'scripts', SCRIPT_NAME)
}

/** token 续期脚本的绝对路径。 */
export function renewScriptPathOf(pluginDir = pluginDirOf()) {
  return join(pluginDir, 'scripts', RENEW_SCRIPT_NAME)
}

/** v2rayN 海外路由规则自愈脚本的绝对路径。 */
export function proxyScriptPathOf(pluginDir = pluginDirOf()) {
  return join(pluginDir, 'scripts', PROXY_SCRIPT_NAME)
}

/** 本地日期键（YYYY-MM-DD）。用本地时区：签到是按上游的"当天"算的。 */
export function localDayKey(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function expandHome(raw, home) {
  if (typeof raw !== 'string' || raw === '') return ''
  if (raw === '~') return home
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(home, raw.slice(2))
  return raw
}

/** 读状态文件；文件不存在或坏了都当成"没领过"，不该因为状态文件而放弃领取。 */
export function readClaimState(file, io = { existsSync, readFileSync }) {
  try {
    if (!io.existsSync(file)) return { days: {} }
    const parsed = JSON.parse(io.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || typeof parsed.days !== 'object') return { days: {} }
    return parsed
  } catch {
    return { days: {} }
  }
}

/** 写状态文件（失败不致命：最多明天再领一次）。 */
export function writeClaimState(file, state, io = { mkdirSync, writeFileSync }) {
  try {
    io.mkdirSync(dirname(file), { recursive: true })
    io.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 当天是否已经领过（领过且当时是成功）。 */
export function claimedToday(state, dayKey) {
  return Boolean(state?.days?.[dayKey]?.ok)
}

/**
 * 创建号池保活器。
 *
 * @param {object} options
 * @param {() => {serverDir?: string, pythonPath?: string, scriptPath?: string, renewScriptPath?: string}} [options.resolve]
 *        解析后端目录/解释器/脚本路径；晚一点再解析也没关系（配置随时可能变）。
 * @param {string} [options.stateFile] 状态文件路径（支持 ~）
 * @param {number} [options.intervalMs] 复查间隔，<=0 表示只在启动时跑一次
 * @param {string} [options.home] ~ 展开用的 home（测试可注入）
 * @param {Function} [options.spawnImpl] 子进程实现（测试可注入）
 * @param {Function} [options.now] 时钟（测试可注入）
 * @param {boolean} [options.renewTokens] 是否做 token 续期（默认开）
 * @param {boolean} [options.dailyCredits] 是否领每日积分（默认开）
 */
export function createCreditKeeper(options = {}) {
  const {
    resolve = () => ({}),
    stateFile = DEFAULT_STATE_FILE,
    intervalMs = DEFAULT_INTERVAL_MS,
    home = homedir(),
    spawnImpl = spawn,
    now = () => new Date(),
    logger = null,
    renewTokens = true,
    dailyCredits = true,
    // 下面两个是为了让测试完全 hermetic（不碰真实磁盘）。
    exists = existsSync,
    stateIo = { existsSync, readFileSync, mkdirSync, writeFileSync },
  } = options

  let timer = null
  let running = false
  let currentChild = null

  const log = (level, message) => {
    try {
      logger?.[level]?.(message)
    } catch {
      /* 日志失败不该影响保活 */
    }
  }

  const statePath = () => expandHome(stateFile, home)

  /** 跑一个 python 脚本，收集输出，带硬超时。 */
  async function runScript(pythonPath, scriptPath, serverDir, label) {
    const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const started = Date.now()
    const result = await new Promise((resolvePromise) => {
      let out = ''
      let settled = false
      let timer = null
      const finish = (payload) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolvePromise(payload)
      }
      let child
      try {
        child = spawnImpl(pythonPath, [scriptPath], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            [ENV_SERVER_DIR]: serverDir,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUNBUFFERED: '1',
          },
        })
      } catch (error) {
        finish({ code: -1, out: `拉起失败: ${error?.message || error}` })
        return
      }
      const collect = (chunk) => {
        out += String(chunk || '')
        if (out.length > 8000) out = out.slice(-8000)
      }
      currentChild = child
      // 硬超时：上游卡住时（实测遇到过 13 分钟的挂起）不能让保活一直占着，
      // 更不能让它在客户端退出后还留着。超时就当失败，等下一轮复查。
      if (timeoutMs > 0) {
        // 故意**不** unref：这个定时器是"卡死兜底"，unref 之后它撑不住事件循环，
        // 进程可能先于它退出 → 兜底永远不触发（单测里就表现为挂起）。
        // 它在子进程 close 时会被 clear，所以不会拖住正常路径。
        timer = setTimeout(() => {
          try {
            child.kill?.()
          } catch {
            /* ignore */
          }
          finish({ code: -1, out: `${out}\n[超时] ${label} 超过 ${Math.round(timeoutMs / 1000)}s 未结束，已终止` })
        }, timeoutMs)
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      child.on('error', (error) => finish({ code: -1, out: `进程错误: ${error?.message || error}` }))
      child.on('close', (code) => {
        currentChild = null
        finish({ code: typeof code === 'number' ? code : -1, out })
      })
    })
    const tail = result.out.trim().split('\n').slice(-4).join(' | ')
    return { ...result, tail, ms: Date.now() - started }
  }

  /**
   * 跑一轮保活：先修 v2rayN 规则（海外号要靠它出海），再续期（脚本内部只动
   * 到期/失效的账号），最后领当日积分（当天领过就跳过）。
   */
  async function runOnce(reason = 'manual') {
    if (running) return { skipped: true, reason: '已在运行' }
    running = true
    try {
      const resolved = resolve() || {}
      const {
        serverDir = '',
        pythonPath = '',
        scriptPath = scriptPathOf(),
        renewScriptPath = renewScriptPathOf(),
        proxyScriptPath = proxyScriptPathOf(),
      } = resolved
      if (!pythonPath || !exists(pythonPath)) {
        log('warn', `minimax-web-api: 找不到 Python 解释器（${pythonPath || '未解析到'}），号池未保活`)
        return { ok: false, reason: '缺少解释器' }
      }

      const summary = { proxy: null, renewed: null, claimed: null }

      // 海外站的出海规则住在 v2rayN 的路由预设里，而预设是可以被切换/更新的，
      // 规则一丢海外号立刻开始 307 跳国内站。原来这一步只由 Windows 计划任务
      // 跑（scripts/claim_daily_credits.cmd 的第 1 步），计划任务删掉后就没人
      // 自愈了，所以搬进插件自己的复查轮次。
      if (proxyScriptPath && exists(proxyScriptPath)) {
        const r = await runScript(pythonPath, proxyScriptPath, serverDir, 'v2rayN 规则自愈')
        summary.proxy = r
        if (r.code === 2) {
          log('warn', `minimax-web-api: v2rayN 的 minimax 海外代理规则被补上了，需要重启 v2rayN 才生效`)
        } else if (r.code !== 0) {
          log('warn', `minimax-web-api: v2rayN 规则自愈脚本异常（exit=${r.code}）：${r.tail}`)
        }
      }

      if (renewTokens) {
        if (!renewScriptPath || !exists(renewScriptPath)) {
          log('warn', `minimax-web-api: 找不到续期脚本（${renewScriptPath || '未解析到'}），token 不会续期`)
        } else {
          const r = await runScript(pythonPath, renewScriptPath, serverDir, 'token 续期')
          summary.renewed = r
          if (r.code === 0) {
            log('info', `minimax-web-api: token 续期完成（${r.ms}ms，触发=${reason}）${r.tail ? `：${r.tail}` : ''}`)
          } else {
            log('warn', `minimax-web-api: token 续期失败（exit=${r.code}，触发=${reason}）：${r.tail}`)
          }
        }
      }

      if (dailyCredits) {
        const day = localDayKey(now())
        const file = statePath()
        const state = readClaimState(file, stateIo)
        if (claimedToday(state, day)) {
          log('debug', `minimax-web-api: 今日（${day}）积分已领取过，跳过`)
          summary.claimed = { skipped: true }
        } else if (!scriptPath || !exists(scriptPath)) {
          log('warn', `minimax-web-api: 找不到领取脚本（${scriptPath || '未解析到'}），今日积分未领取`)
        } else {
          const r = await runScript(pythonPath, scriptPath, serverDir, '积分领取')
          summary.claimed = r
          if (r.code === 0) {
            const next = { ...state, days: { ...(state.days || {}), [day]: { ok: true, at: new Date().toISOString() } } }
            writeClaimState(file, next, stateIo)
            log('info', `minimax-web-api: 每日积分已处理（${day}，${r.ms}ms，触发=${reason}）${r.tail ? `：${r.tail}` : ''}`)
          } else {
            log('warn', `minimax-web-api: 每日积分领取失败（${day}，exit=${r.code}，触发=${reason}）：${r.tail}`)
          }
        }
      }

      return { ok: true, ...summary }
    } finally {
      running = false
    }
  }

  return {
    /** 立刻跑一轮，并按间隔复查。不阻塞调用方。 */
    start() {
      void runOnce('startup')
      if (Number(intervalMs) > 0) {
        timer = setInterval(() => void runOnce('timer'), Number(intervalMs))
        timer.unref?.()
      }
      return this
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      // 客户端退出时别把脚本留成孤儿进程。
      try {
        currentChild?.kill?.()
      } catch {
        /* ignore */
      }
      currentChild = null
    },
    runOnce,
    statePath,
  }
}
