import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { createBackendManager, baseUrlOf } from '../lib/server.js'

/**
 * 真实生命周期验证：插件自己拉起 Python 后端，用完按进程树回收。
 *
 * 这是纯函数测试覆盖不到的一段——"托管模式"到底有没有真的把 uvicorn 拉起来、
 * dispose 之后 4555 是否真的空出来。它需要本机后端目录与已装好的 .venv，
 * 所以不放进 smoke（CI 上没有这些），单独用 `node test/live_lifecycle.mjs` 跑。
 *
 * 前提：4555 上现在没有别的实例在跑（否则 ensure() 会复用别人，测不到拉起与回收）。
 */

function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

const logs = []
const logger = {
  debug: (m) => logs.push(`DEBUG ${m}`),
  info: (m) => logs.push(`INFO ${m}`),
  warn: (m) => logs.push(`WARN ${m}`),
}

const opts = {
  baseUrl: 'http://127.0.0.1:4555',
  autoStart: true,
  startTimeoutMs: 60000,
  healthTtlMs: 0,
  streamIdleTimeoutMs: 180000,
  logFile: join(homedir(), '.dsh', 'logs', 'minimax-web-api.log'),
  killTreeOnDispose: true,
  detach: false,
  passEnvKeys: [],
  strictBackend: true,
}

if (await portOpen(4555)) {
  console.error('❌ 4555 已被占用：先停掉那个实例再跑本测试（否则测到的是复用，不是拉起）')
  process.exit(2)
}

const manager = createBackendManager(opts, logger)

try {
  console.log('1) ensure() —— 应自动拉起 python run.py')
  const health = await manager.ensure()
  console.log('   health:', JSON.stringify(health))
  assert.equal(typeof health.status, 'string')
  assert.ok(manager.pid() > 0, '应记录后端子进程 PID')
  console.log('   pid:', manager.pid(), 'serverDir:', manager.serverDir())

  console.log('2) 端口应真的在听')
  assert.equal(await portOpen(4555), true, '拉起后 4555 应可连接')

  console.log('3) 再 ensure() 一次 —— 应命中缓存/复用，不重复拉起')
  const again = await manager.ensure()
  assert.equal(again.status, health.status)
  console.log('   复用成功，PID 仍是', manager.pid())

  console.log('4) dispose() —— 应按进程树回收')
  manager.dispose()
  // 端口释放是异步的，给一小段时间轮询
  let closed = false
  for (let i = 0; i < 20; i += 1) {
    if (!(await portOpen(4555))) {
      closed = true
      break
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  assert.equal(closed, true, 'dispose 之后 4555 应已关闭')
  console.log('✅ 自动拉起 → 复用 → 进程树回收 全部通过')
} finally {
  manager.dispose()
  if (logs.length > 0) {
    console.log('--- 插件日志 ---')
    for (const line of logs.slice(-20)) console.log(line)
  }
}