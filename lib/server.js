import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildChildEnv, buildSpawnPlan, isAlive, killProcessTree } from './process.js'
import { DEFAULT_POINTER_FILE, ENV_SERVER_DIR, resolveLogFile, resolvePython, resolveServerDir, writePointer } from './paths.js'
import { checkContract, contractError } from './contract.js'

/**
 * minimax2api 后端进程生命周期管理器。
 *
 * 与 dsh-deepseek-web-api/lib/server.js 同构，差别在于被托管的不是 Node dist，
 * 而是 **Python**：`python run.py --host 127.0.0.1 --port 4555 --data-dir <dir>`。
 * 因此这里没有“构建产物”概念（就绪判定只看 /health），但要负责找解释器、
 * 传对工作目录、并在回收时按进程树带走 uvicorn 的派生进程。
 *
 * 设计取舍：
 *   1. 优先复用已有实例（GET /health，结果按 TTL 缓存）；
 *   2. 未运行且 autoStart 时拉起；
 *   3. dispose 按进程树回收（detach: true 则有意留下）；
 *   4. 复用别人起的实例时比对 /health 自述与插件期望，不一致就告警——
 *      真机上吃过“跑的是手工起的旧进程、注入的开关从未生效”的亏。
 */

const DEFAULT_HEALTH_TTL_MS = 30000
const LOG_FILE_MAX_BYTES = 2 * 1024 * 1024

export function baseUrlOf(opts = {}) {
  return String(opts.baseUrl || 'http://127.0.0.1:4555').replace(/\/+$/, '')
}

/** 从 baseUrl 里取端口，拉不起监听时用来拼命令行。 */
export function portOf(opts = {}) {
  try {
    return Number(new URL(baseUrlOf(opts)).port || 4555)
  } catch {
    return 4555
  }
}

/** 探活并取回 /health 的自述信息；不在线或形状不对返回 null。 */
export async function probe(opts = {}, fetchImpl = globalThis.fetch) {
  const url = `${baseUrlOf(opts)}/health`
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(Number(opts.probeTimeoutMs || 3000)),
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

/** 兼容旧调用点：只关心在不在跑。 */
export async function ping(opts = {}, fetchImpl = globalThis.fetch) {
  return (await probe(opts, fetchImpl)) !== null
}

/**
 * 比对复用实例自述与插件期望。
 * minimax2api 的 /health 没有版本与开关字段，所以能比的只有号池状态：
 * usableAccounts=0 是运行状态（还没导账号），不是“后端太旧”，只告警不拒用。
 */
export function diffHealth(health) {
  const warnings = []
  if (!health || typeof health !== 'object') return { warnings: ['/health 没有返回 JSON'] }
  if (typeof health.status !== 'string') warnings.push('/health 缺少 status 字段，可能不是 minimax2api')
  const usable = Number(health.usableAccounts)
  if (Number.isFinite(usable) && usable === 0) {
    warnings.push('号池里没有可用账号：打开 http://127.0.0.1:4555/admin 导入 MiniMax 凭据后才会真正出字')
  }
  return { warnings }
}

export function createBackendManager(opts = {}, logger) {
  let child = null
  let starting = null
  let cachedHealth = null
  let healthyUntil = 0
  let lastPid = 0
  let warnedNoAccount = false
  const recentLogs = []

  const note = (level, message) => {
    const text = `minimax-web-api: ${message}`
    if (typeof logger?.[level] === 'function') logger[level](text)
  }

  const pluginDir = opts.pluginDir || dirname(fileURLToPath(import.meta.url))
  let resolved = resolveServerDir(opts, { pluginDir })
  let serverDir = resolved.dir
  const logFile = resolveLogFile(opts.logFile)
  for (const item of resolved.notes) note('debug', `后端目录解析：${item}`)
  if (serverDir) note('debug', `后端目录 = ${serverDir}（来源 ${resolved.source}）`)
  else note('warn', `没有解析到后端目录。${resolved.notes.join(' | ')}`)

  function writeLogFile(line) {
    if (!logFile) return
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8')
      if (statSync(logFile).size > LOG_FILE_MAX_BYTES) {
        const rotated = `${logFile}.1`
        if (existsSync(rotated)) unlinkSync(rotated)
        appendFileSync(rotated, readFileSync(logFile), 'utf8')
      }
    } catch {
      // 日志落盘失败不该影响推理链路
    }
  }

  function remember(line) {
    if (!line) return
    for (const row of String(line).split('\n')) {
      if (!row) continue
      recentLogs.push(row)
      if (recentLogs.length > 200) recentLogs.shift()
      writeLogFile(row)
    }
  }

  function dataDir() {
    const configured = typeof opts.dataDir === 'string' ? opts.dataDir.trim() : ''
    if (configured) return configured
    return join(serverDir || '.', 'data')
  }

  function spawnServer() {
    // 后端可能在插件加载之后才被克隆出来，所以这里重新解析一次再判定。
    if (!serverDir) {
      resolved = resolveServerDir(opts, { pluginDir })
      serverDir = resolved.dir
    }
    if (!serverDir) {
      throw new Error(
        `找不到 minimax2api 后端目录（一个都没命中）。\n` +
        `尝试过的线索：${resolved.notes.join(' | ') || '(无)'}\n` +
        `请在配置里写 serverDir，或设置环境变量 ${ENV_SERVER_DIR}，或用 install.ps1 -BackendDir 指定一次。`
      )
    }

    const python = resolvePython(opts, serverDir)
    for (const item of python.notes) note('debug', `解释器解析：${item}`)
    note('debug', `Python = ${python.path}（来源 ${python.source}）`)

    const { env, keys } = buildChildEnv(process.env, {
      extraKeys: Array.isArray(opts.passEnvKeys) ? opts.passEnvKeys : [],
      inject: {
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        ...(opts.env || {}),
      },
    })
    note('debug', `子进程环境变量（只记名不记值）: ${keys.join(', ')}`)

    const port = portOf(opts)
    const args = ['run.py', '--host', '127.0.0.1', '--port', String(port), '--data-dir', dataDir()]
    const fds = opts.detach === true && logFile ? openLogFileStreams(logFile) : {}
    const plan = buildSpawnPlan({ ...opts, cwd: serverDir }, fds)
    const proc = spawn(python.path, args, { ...plan, env })
    lastPid = proc.pid
    note('info', `已拉起后端 PID=${proc.pid} 模式=${opts.detach === true ? 'detach' : '托管'} port=${port}`)

    if (proc.stdout) proc.stdout.on('data', (buf) => remember(String(buf).trimEnd()))
    if (proc.stderr) proc.stderr.on('data', (buf) => remember(String(buf).trimEnd()))
    proc.on('exit', (code) => {
      remember(`[minimax-web-api 退出] code=${code}`)
      if (child === proc) child = null
      cachedHealth = null
      healthyUntil = 0
    })
    proc.on('error', (error) => remember(`[minimax-web-api 进程错误] ${error?.message || error}`))

    if (opts.detach === true) {
      child = null
      proc.unref?.()
    } else {
      child = proc
    }
    return proc
  }

  /** 探活 + 最小契约校验；号池为空只告警一次。 */
  async function freshHealth() {
    const health = await probe(opts, opts.fetchImpl)
    if (!health) {
      cachedHealth = null
      healthyUntil = 0
      return null
    }
    cachedHealth = health
    healthyUntil = Date.now() + Number(opts.healthTtlMs || DEFAULT_HEALTH_TTL_MS)

    const contract = checkContract(health, opts)
    if (!contract.ok) {
      if (opts.strictBackend === false) {
        for (const item of contract.problems) note('warn', `后端不满足契约（strictBackend=false，仍复用）：${item}`)
      } else {
        note('warn', `拒绝复用后端：${contract.problems.join('；')}`)
        throw Object.assign(new Error(contractError(serverDir, contract.problems)), { failureCode: 'BACKEND_STALE' })
      }
    }

    const { warnings } = diffHealth(health)
    for (const item of warnings) {
      if (/号池里没有可用账号/.test(item)) {
        if (warnedNoAccount) continue
        warnedNoAccount = true
      }
      note('warn', item)
    }
    note('debug', `后端自述 status=${health.status} accounts=${health.accounts} usable=${health.usableAccounts} upstream=${health.upstream}`)
    return health
  }

  async function ensure() {
    const ttl = Number(opts.healthTtlMs || DEFAULT_HEALTH_TTL_MS)
    if (ttl > 0 && cachedHealth && Date.now() < healthyUntil) return cachedHealth
    const alive = await freshHealth()
    if (alive) return alive
    if (opts.autoStart === false) {
      throw new Error(
        `minimax2api 服务未在 ${baseUrlOf(opts)} 运行，且 autoStart=false。\n` +
        `请手动启动服务（cd ${serverDir || '<后端目录>'} && python run.py --port ${portOf(opts)}）或在配置中开启 autoStart: true。`
      )
    }
    if (starting) return starting

    starting = (async () => {
      note('info', `正在启动后端反代服务: ${serverDir || '(未解析到目录)'}`)
      spawnServer()

      const timeoutMs = Number(opts.startTimeoutMs || 60000)
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (lastPid !== 0 && !isAlive(lastPid)) {
          const where = logFile ? `详见日志文件 ${logFile}` : '(无最近日志)'
          throw new Error(
            `minimax2api 服务启动失败（PID=${lastPid} 已退出）。${where}\n` +
            `最近日志:\n${recentLogs.slice(-30).join('\n')}`
          )
        }
        const ready = await freshHealth().catch((error) => {
          // 契约失败是终局，不该等到超时；其它异常（服务还没起来）继续轮询。
          if (error?.failureCode === 'BACKEND_STALE') throw error
          return null
        })
        if (ready) {
          note('info', `后端服务已就绪 (${baseUrlOf(opts)})`)
          return ready
        }
        await new Promise((r) => setTimeout(r, 700))
      }
      throw new Error(
        `minimax2api 服务在 ${timeoutMs}ms 内未就绪。最近日志:\n${recentLogs.slice(-30).join('\n')}`
      )
    })().finally(() => {
      starting = null
    })

    return starting
  }

  function dispose() {
    if (opts.detach === true) {
      note('info', `detach 模式：保留后端 PID=${lastPid}，不由插件回收`)
      cachedHealth = null
      healthyUntil = 0
      return
    }
    const target = child?.pid || (isAlive(lastPid) ? lastPid : 0)
    if (target) {
      if (opts.killTreeOnDispose !== false) {
        const result = killProcessTree(target, { force: true })
        note('info', `回收后端进程树 PID=${target} method=${result.method} ok=${result.ok}${result.detail ? ` (${result.detail})` : ''}`)
        if (!result.ok) note('warn', `进程树回收未确认：${result.detail}`)
      } else {
        try {
          child?.kill()
          note('info', `仅回收直接子进程 PID=${target}（killTreeOnDispose=false）`)
        } catch {
          // 忽略可能已退出的异常
        }
      }
    }
    child = null
    cachedHealth = null
    healthyUntil = 0
  }

  return {
    ensure,
    dispose,
    health: () => cachedHealth,
    serverDir: () => serverDir,
    pythonPath: () => resolvePython(opts, serverDir).path,
    dataDir,
    pinServerDir: (file) => (serverDir
      ? writePointer(file || DEFAULT_POINTER_FILE, serverDir, null, resolvePython(opts, serverDir).path)
      : null),
    pid: () => (child?.pid || lastPid) ?? 0,
    tail: () => recentLogs.slice(-20).join('\n'),
    get isRunning() {
      return child !== null || isAlive(lastPid)
    },
  }
}

/** detach + logFile 组合下把后端 stdio 直接接到日志文件上。 */
function openLogFileStreams(logFile) {
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    return {
      stdout: openSync(logFile, 'a'),
      stderr: openSync(logFile, 'a'),
    }
  } catch {
    return {}
  }
}
