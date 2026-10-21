import { spawnSync } from 'node:child_process'

/**
 * 进程树回收与子进程环境白名单。
 *
 * 与 dsh-deepseek-web-api 的同名模块同构，但这里拉起的不是 Node 后端而是 **Python**
 * （`python run.py`，uvicorn 跑在同一进程里），所以白名单要放行 Python 与代理相关变量：
 * 海外版 MiniMax 业务接口锁海外出口，用户常常靠 `HTTPS_PROXY` 之类的变量出网；
 * 把代理变量挡掉会让"插件起的后端连不上上游"变成一个极难看的故障。
 *
 * @module lib/process.js
 */

/** 探测某个 PID 是否还活着（不发信号）。 */
export function isAlive(pid) {
  const numeric = Number(pid)
  if (!Number.isInteger(numeric) || numeric <= 0) return false
  try {
    process.kill(numeric, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 连带子进程一起结束。
 * @param {number} pid 目标进程
 * @param {{ force?: boolean, platform?: NodeJS.Platform }} [options]
 * @returns {{ ok: boolean, method: string, detail: string }}
 */
export function killProcessTree(pid, options = {}) {
  const numeric = Number(pid)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return { ok: false, method: 'none', detail: `无效 PID: ${pid}` }
  }
  const platform = options.platform || process.platform
  const force = options.force !== false

  if (platform === 'win32') {
    // taskkill /T 会沿父子关系往下收；uvicorn 与它可能派生的子进程一起带走。
    const args = ['/PID', String(numeric), '/T']
    if (force) args.push('/F')
    const result = spawnSync('taskkill', args, { windowsHide: true, encoding: 'utf8' })
    const detail = String(result.stderr || result.stdout || '').trim()
    if (result.status === 0) return { ok: true, method: 'taskkill', detail }
    // 没有这样的进程：目标已经自己退了，按幂等成功处理
    const alreadyGone = /没有这样的进程|not found|No such/i.test(detail)
    return { ok: alreadyGone, method: 'taskkill', detail: detail || `exit=${result.status}` }
  }

  // POSIX：负号打的是整个进程组（要求 spawn 时 detached，见 buildSpawnPlan）。
  try {
    process.kill(-numeric, force ? 'SIGKILL' : 'SIGTERM')
    return { ok: true, method: 'process-group', detail: `pgid=${numeric}` }
  } catch (error) {
    const code = error?.code
    if (code === 'ESRCH') return { ok: true, method: 'process-group', detail: '进程组已退出' }
    // 不是组长（没 detached）时退化成单进程信号，至少不比旧行为差。
    try {
      process.kill(numeric, force ? 'SIGKILL' : 'SIGTERM')
      return { ok: true, method: 'single', detail: `进程组信号失败(${code})，退化为单进程` }
    } catch (inner) {
      return { ok: false, method: 'single', detail: String(inner?.code || inner) }
    }
  }
}

/**
 * 决定怎么拉起后端。
 * - 托管模式（默认）：pipes，插件能 tail 最近日志、能在 dispose 时收树；
 *   代价是父进程一旦被强杀，子进程写 stdout 会 EPIPE（Python 侧通常是 BrokenPipeError）而退出。
 * - detach 模式：新进程组 + stdio 落文件（配了 logFile）或忽略，父进程退出不再牵连后端。
 *
 * @param {{ detach?: boolean, logFile?: string, cwd?: string, serverDir?: string }} opts
 * @param {{ stdout?: number, stderr?: number }} [fds]
 */
export function buildSpawnPlan(opts = {}, fds = {}) {
  const detached = opts.detach === true
  const useFiles = detached === true && Boolean(opts.logFile) && Boolean(fds.stdout) && Boolean(fds.stderr)
  return {
    detached,
    windowsHide: true,
    cwd: opts.cwd || opts.serverDir,
    stdio: detached
      ? useFiles ? ['ignore', fds.stdout, fds.stderr] : ['ignore', 'ignore', 'ignore']
      : ['ignore', 'pipe', 'pipe'],
  }
}

/**
 * 传给后端子进程的变量白名单。
 *
 * 只放三类：跑起 Python 与网络栈必需的 OS 变量、出网可能用到的代理变量，
 * 以及反代自己声明的 `MINIMAX2API_` 命名空间。宿主的 `PORT`/`HOST` 不会渗进去
 * （端口与绑定地址由插件用命令行参数显式给出）。
 */
export const ENV_BASE_ALLOWLIST = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'TEMP', 'TMP', 'HOME',
  'TZ', 'LANG', 'LC_ALL',
  // 出网：海外版业务接口锁海外出口，代理是常见部署方式
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  // Python 自身的编码与缓冲行为
  'PYTHONPATH', 'PYTHONHOME', 'PYTHONIOENCODING', 'PYTHONUTF8', 'PYTHONUNBUFFERED',
])

/** 后端认识的命名空间；其余环境变量一律不进子进程。 */
export const ENV_PASSTHROUGH_PREFIX = 'MINIMAX2API_'

/**
 * 组子进程环境。
 * @param {Record<string, string | undefined>} source 通常传 process.env
 * @param {{ inject?: Record<string, string | number>, extraKeys?: string[] }} [options]
 *   inject 为插件显式设定（优先级最高），extraKeys 给用户兜底自己需要透传的变量名。
 * @returns {{ env: Record<string, string>, keys: string[] }}
 */
export function buildChildEnv(source = {}, options = {}) {
  const env = {}
  for (const key of ENV_BASE_ALLOWLIST) {
    const value = source[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith(ENV_PASSTHROUGH_PREFIX)) continue
    if (typeof value !== 'string' || value === '') continue
    env[key] = value
  }
  for (const key of Array.isArray(options.extraKeys) ? options.extraKeys : []) {
    const value = source[key]
    if (typeof key === 'string' && typeof value === 'string' && value !== '') env[key] = value
  }
  for (const [key, value] of Object.entries(options.inject || {})) {
    if (value === undefined || value === null || value === '') continue
    env[key] = String(value)
  }
  return { env, keys: Object.keys(env).sort() }
}