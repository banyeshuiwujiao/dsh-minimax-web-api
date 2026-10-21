// 每日积分领取（签到）——跟着 DSH 客户端的生命周期走。
//
// 为什么放在插件里，而不是只靠 Windows 计划任务：
//   计划任务是**墙钟触发**（每天 09:05）且要求 Windows 已登录，跟"DSH 客户端开没开"
//   无关。09:05 之后才开客户端 → 那天领不到；连续开着但 09:05 那一刻网络不通 →
//   整条断掉，第二天才有下一次机会。
//   插件是随 DSH 客户端一起加载的，所以"客户端开着"就能保证当天领到：
//     · 启动时确保一次（当天已领过则幂等跳过）；
//     · 之后每隔 creditIntervalMs 再查一次，补上启动时失败的情况。
//   计划任务保留为第二道保险（客户端没开时也能领），两者用的是同一个脚本。
//
// 领取动作本身在 scripts/claim_daily_credits.py：签名、代理、错误分类都复用
// minimax2api 自带的实现，这里只负责"什么时候跑"与"今天跑过了没有"。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 状态文件：记下每天领取的结果，避免同一天重复跑脚本。 */
export const DEFAULT_STATE_FILE = '~/.dsh/minimax-web-api/claim-state.json'
/** 复查间隔：6 小时。启动时领过一次，之后每 6 小时再确认一次当天是否真的领到。 */
export const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 单次领取的硬超时：上游卡住时不能一直占着（实测遇到过 13 分钟的挂起）。 */
export const DEFAULT_TIMEOUT_MS = 120 * 1000
export const SCRIPT_NAME = 'claim_daily_credits.py'
export const ENV_SERVER_DIR = 'MINIMAX2API_DIR'

/** 插件根目录（lib/ 的上一级）。 */
export function pluginDirOf(here = dirname(fileURLToPath(import.meta.url))) {
  return join(here, '..')
}

/** 领取脚本的绝对路径。 */
export function scriptPathOf(pluginDir = pluginDirOf()) {
  return join(pluginDir, 'scripts', SCRIPT_NAME)
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
 * 创建领取器。
 *
 * @param {object} options
 * @param {() => {serverDir?: string, pythonPath?: string, scriptPath?: string}} [options.resolve]
 *        解析后端目录/解释器/脚本路径；晚一点再解析也没关系（配置随时可能变）。
 * @param {string} [options.stateFile] 状态文件路径（支持 ~）
 * @param {number} [options.intervalMs] 复查间隔，<=0 表示只在启动时领一次
 * @param {string} [options.home] ~ 展开用的 home（测试可注入）
 * @param {Function} [options.spawnImpl] 子进程实现（测试可注入）
 * @param {Function} [options.now] 时钟（测试可注入）
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
      /* 日志失败不该影响领取 */
    }
  }

  const statePath = () => expandHome(stateFile, home)

  async function runOnce(reason = 'manual') {
    if (running) return { skipped: true, reason: '已在运行' }
    const day = localDayKey(now())
    const file = statePath()
    const state = readClaimState(file, stateIo)
    if (claimedToday(state, day)) {
      log('debug', `minimax-web-api: 今日（${day}）积分已领取过，跳过`)
      return { skipped: true, reason: '今日已领取' }
    }

    const { serverDir = '', pythonPath = '', scriptPath = scriptPathOf() } = resolve() || {}
    if (!pythonPath || !exists(pythonPath)) {
      log('warn', `minimax-web-api: 找不到 Python 解释器（${pythonPath || '未解析到'}），今日积分未领取`)
      return { ok: false, reason: '缺少解释器' }
    }
    if (!scriptPath || !exists(scriptPath)) {
      log('warn', `minimax-web-api: 找不到领取脚本（${scriptPath || '未解析到'}），今日积分未领取`)
      return { ok: false, reason: '缺少脚本' }
    }

    running = true
    const started = Date.now()
    const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
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
          resolvePromise({ code: -1, out: `拉起失败: ${error?.message || error}` })
          return
        }
        const collect = (chunk) => {
          out += String(chunk || '')
          if (out.length > 8000) out = out.slice(-8000)
        }
        currentChild = child
        // 硬超时：上游卡住时（实测遇到过 13 分钟的挂起）不能让领取一直占着，
        // 更不能让它在客户端退出后还留着。超时就当失败，等下一次复查。
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
            finish({ code: -1, out: `${out}\n[超时] 领取脚本超过 ${Math.round(timeoutMs / 1000)}s 未结束，已终止` })
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

      const tail = result.out.trim().split('\n').slice(-6).join(' | ')
      if (result.code === 0) {
        const next = { ...state, days: { ...(state.days || {}), [day]: { ok: true, at: new Date().toISOString() } } }
        writeClaimState(file, next, stateIo)
        log('info', `minimax-web-api: 每日积分已处理（${day}，${Date.now() - started}ms，触发=${reason}）${tail ? `：${tail}` : ''}`)
        return { ok: true, day }
      }
      log('warn', `minimax-web-api: 每日积分领取失败（${day}，exit=${result.code}，触发=${reason}）：${tail}`)
      return { ok: false, reason: `exit=${result.code}` }
    } finally {
      running = false
    }
  }

  return {
    /** 立刻确保一次，并按间隔复查。不阻塞调用方。 */
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
      // 客户端退出时别把领取脚本留成孤儿进程。
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
