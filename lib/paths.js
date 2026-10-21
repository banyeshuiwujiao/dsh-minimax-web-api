import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * 后端目录、Python 解释器与日志路径的解析。
 *
 * 与 dsh-deepseek-web-api 的 paths.js 同一套思路：配置文件里不写死某台机器的绝对路径，
 * 解析顺序固定为 配置 → 环境变量 → 指针文件 → 插件同级 → home 常见位置。
 *
 * 判定"这是 minimax2api 后端"的标志不是 dist/index.js（它是 Python 项目，没有构建产物），
 * 而是 run.py + app/server.py 两个文件同时存在。
 *
 * @module lib/paths.js
 */

/** 指针文件：install.ps1 写入，记录本机后端真实位置。 */
export const DEFAULT_POINTER_FILE = '~/.dsh/minimax2api.json'

/** 允许不改配置文件就指定后端目录的环境变量。 */
export const ENV_SERVER_DIR = 'DSH_MINIMAX2API_DIR'

/** 允许不改配置文件就指定 Python 解释器的环境变量。 */
export const ENV_PYTHON = 'DSH_MINIMAX2API_PYTHON'

/** 没找到后端时的常见候选位置（相对 home），按命中概率排序。 */
export const FALLBACK_CANDIDATES = Object.freeze([
  'DeepSeek_Harness/git-repo/minimax2api',
  'DeepSeek_Harness/git-repo/minimaxcode2api',
  'DeepSeek_Harness/minimax2api',
  'git-repo/minimax2api',
  'minimax2api',
  'Desktop/DeepSeek_Harness/git-repo/minimax2api',
  'Documents/DeepSeek_Harness/git-repo/minimax2api',
])

/** 源码形态下（未装到运行时镜像时）插件自身往上找的位置。 */
export const SIBLING_CANDIDATES = Object.freeze([
  '../../../git-repo/minimax2api',
  '../../git-repo/minimax2api',
  '../minimax2api',
])

/** 把 `~` 或 `~/x` 展开成用户主目录下的路径；绝对路径原样返回。 */
export function expandHome(raw, home = homedir()) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return ''
  if (text === '~') return home
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(home, text.slice(2))
  return text
}

/** 判定"这是一个可用的 minimax2api 后端目录"：run.py 与 app/server.py 都在。 */
export function isBackendDir(dir, exists = existsSync) {
  if (!dir) return false
  return exists(join(dir, 'run.py')) && exists(join(dir, 'app', 'server.py'))
}

/** 读指针文件；任何异常都当作"没有指针"，不让日志/配置读取打断推理链路。 */
export function readPointer(file, io = { existsSync, readFileSync }) {
  const path = expandHome(file)
  if (!path || !io.existsSync(path)) return null
  try {
    const parsed = JSON.parse(io.readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && typeof parsed.serverDir === 'string') {
      return {
        serverDir: parsed.serverDir,
        gitRev: typeof parsed.gitRev === 'string' ? parsed.gitRev : null,
        pythonPath: typeof parsed.pythonPath === 'string' ? parsed.pythonPath : '',
      }
    }
  } catch {
    // 指针坏了就当没有，回落到候选发现
  }
  return null
}

/** 写指针文件（install.ps1 调用；目录不存在会创建）。 */
export function writePointer(file, serverDir, gitRev = null, pythonPath = '', io = { mkdirSync, writeFileSync }) {
  const path = expandHome(file)
  io.mkdirSync(dirname(path), { recursive: true })
  const payload = { serverDir, gitRev, pythonPath, updatedAt: new Date().toISOString() }
  io.writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return path
}

/**
 * 解析后端目录。优先级：配置 > 环境变量 > 指针文件 > 插件同级（源码形态）> home 下常见位置。
 *
 * 配置里写了但那个目录不成立时**不一票否决**，继续往下找并把原因记进 `notes`——
 * "配置文件里的绝对路径属于另一台机器"正是本模块要解决的故障。
 *
 * @param {{ serverDir?: string, pointerFile?: string }} opts
 * @param {{ env?: Record<string,string|undefined>, home?: string, pluginDir?: string, exists?: (p:string)=>boolean, read?: (p:string)=>string }} [io]
 * @returns {{ dir: string, source: string, notes: string[] }}
 */
export function resolveServerDir(opts = {}, io = {}) {
  const env = io.env || process.env
  const home = io.home || homedir()
  const exists = io.exists || existsSync
  const read = io.read || ((p) => readFileSync(p, 'utf8'))
  const notes = []

  const configured = expandHome(opts.serverDir, home)
  if (configured) {
    if (isBackendDir(configured, exists)) return { dir: configured, source: 'config', notes }
    notes.push(`配置里的 serverDir 不是 minimax2api 目录（缺 run.py 或 app/server.py），已忽略并继续探测: ${configured}`)
  }

  const fromEnv = expandHome(env[ENV_SERVER_DIR], home)
  if (fromEnv) {
    if (isBackendDir(fromEnv, exists)) return { dir: fromEnv, source: `env:${ENV_SERVER_DIR}`, notes }
    notes.push(`环境变量 ${ENV_SERVER_DIR} 指向的目录不是 minimax2api 目录: ${fromEnv}`)
  }

  // 先把 `~` 按**本次解析用的 home** 展开再交给 readPointer：readPointer 内部
  // 没有 home 参数，若直接传 `~/...` 它会用真实 homedir 展开，测试注入的 home 就失效了。
  const pointerPath = expandHome(opts.pointerFile || DEFAULT_POINTER_FILE, home)
  const pointer = readPointer(pointerPath, { existsSync: exists, readFileSync: read })
  if (pointer && isBackendDir(pointer.serverDir, exists)) {
    return {
      dir: pointer.serverDir,
      source: 'pointer',
      notes: [...notes, ...(pointer.gitRev ? [`指针记录的后端 git 版本 ${pointer.gitRev}`] : [])],
    }
  }

  if (io.pluginDir) {
    for (const rel of SIBLING_CANDIDATES) {
      const candidate = resolve(join(io.pluginDir, rel))
      if (isBackendDir(candidate, exists)) return { dir: candidate, source: 'sibling', notes }
    }
  }

  for (const rel of FALLBACK_CANDIDATES) {
    const candidate = join(home, rel)
    if (isBackendDir(candidate, exists)) return { dir: candidate, source: 'discover', notes }
  }

  const searched = [configured, fromEnv, expandHome(opts.pointerFile || DEFAULT_POINTER_FILE, home)]
    .filter(Boolean)
    .concat(FALLBACK_CANDIDATES.map((rel) => join(home, rel)))
  return {
    dir: '',
    source: 'none',
    notes: [...notes, `已尝试：${searched.join(' | ')}`],
  }
}

/**
 * 解析 Python 解释器。优先级：配置 pythonPath → 环境变量 → 后端自带 venv → PATH 上的 python。
 *
 * 先找 venv 是有理由的：这个后端要 fastapi/uvicorn/httpx，系统 Python 常常没装；
 * install.ps1 会在后端目录建 .venv，插件直接复用，用户不必再记一次 pip install。
 *
 * @param {{ pythonPath?: string }} opts
 * @param {string} serverDir
 * @param {{ env?: Record<string,string|undefined>, home?: string, exists?: (p:string)=>boolean, platform?: string }} [io]
 * @returns {{ path: string, source: string, notes: string[] }}
 */
export function resolvePython(opts = {}, serverDir = '', io = {}) {
  const env = io.env || process.env
  const home = io.home || homedir()
  const exists = io.exists || existsSync
  const platform = io.platform || process.platform
  const notes = []

  const configured = expandHome(opts.pythonPath, home)
  if (configured) {
    if (exists(configured)) return { path: configured, source: 'config', notes }
    notes.push(`配置里的 pythonPath 不存在: ${configured}`)
  }

  const fromEnv = expandHome(env[ENV_PYTHON], home)
  if (fromEnv) {
    if (exists(fromEnv)) return { path: fromEnv, source: `env:${ENV_PYTHON}`, notes }
    notes.push(`环境变量 ${ENV_PYTHON} 指向的解释器不存在: ${fromEnv}`)
  }

  if (serverDir) {
    const venvPaths = platform === 'win32'
      ? [join(serverDir, '.venv', 'Scripts', 'python.exe'), join(serverDir, 'venv', 'Scripts', 'python.exe')]
      : [join(serverDir, '.venv', 'bin', 'python'), join(serverDir, 'venv', 'bin', 'python')]
    for (const candidate of venvPaths) {
      if (exists(candidate)) return { path: candidate, source: 'venv', notes }
    }
    notes.push(`后端目录下没有可用的 venv（试过 ${venvPaths.join(' | ')}）`)
  }

  // PATH 兜底：交给 spawn 自己解析，这里只给名字。
  return { path: platform === 'win32' ? 'python.exe' : 'python3', source: 'PATH', notes }
}

/** 解析日志文件路径（支持 `~`）；空值表示不落盘。 */
export function resolveLogFile(raw, home = homedir()) {
  const text = expandHome(raw, home)
  if (text === '') return ''
  return text
}