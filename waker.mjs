/**
 * dsh-waker —— 独立于 DSH 的唤醒器。
 *
 * 为什么需要它：插件跑在 DSH 进程里，DSH 没起来时它不存在，
 * 任何 QQ 命令都收不到。所以"用命令拉起 DSH"必须由一个不依赖 DSH 的进程来做。
 *
 * 行为：
 *   连 NapCat 的 WS 3001，只认白名单 QQ 的 #start / #启动 / #开机。
 *   先探 19387：通了就说明 DSH 在跑 —— 此时保持沉默，让插件那边正常回答，
 *   避免一句话两个回复。没通才启动 DeepSeek Harness.exe，并轮询到端口可用为止。
 *
 * 运行方式（登录时由计划任务拉起，隐藏窗口）：
 *   pythonw.exe run-hidden.py <node.exe> <本文件>
 *
 * 单独探测（不常驻，看完就退）：
 *   node waker.mjs --probe
 */
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { dirname } from 'node:path'
import { connect } from 'onebot.js'

// 默认配置；插件安装时会把实际值写进同目录的 waker.config.json 覆盖它。
const CFG = {
  ws: 'ws://127.0.0.1:3001',
  allow: [123456789],
  prefix: '#',
  exe: 'D:\\DSH\\DeepSeek Harness.exe',
  // 这个任务的动作就是直接跑 exe，没有包装脚本 —— 由任务计划服务启动，
  // 不继承 run-hidden.py 的 Job Object，不会被 kill-on-close 带走。
  task: 'DSH Start',
  port: 19387,
  waitSecs: 150,
  singletonPort: 38017,
}
try {
  const cfgFile = join(dirname(fileURLToPath(import.meta.url)), 'waker.config.json')
  if (existsSync(cfgFile)) Object.assign(CFG, JSON.parse(readFileSync(cfgFile, 'utf8').replace(/^﻿/, '')))
} catch {
  /* 配置缺失或损坏时用默认值 */
}

const LOG = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-waker.log')
const log = (m) => {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`)
  } catch {
    /* 日志失败不影响功能 */
  }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** 当前 DeepSeek Harness 进程数；-1 表示查询失败。区分"进程没起"与"起了但端口没通"。 */
const HEARTBEAT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'qq-router-heartbeat')

/**
 * 插件心跳距今多少毫秒；没有心跳返回 null。
 * 为什么不用进程数判断"DSH 在不在"：关闭 DSH 后残留进程仍然存在，进程数 > 0，
 * 唤醒器会以为插件会回答而保持沉默，实际没人回答，命令就石沉大海。
 */
function pluginHeartbeatAgeMs() {
  try {
    const ts = Number(readFileSync(HEARTBEAT, 'utf8').trim())
    if (!Number.isFinite(ts) || ts <= 0) return null
    return Date.now() - ts
  } catch {
    return null
  }
}

function dshProcessCount() {
  return new Promise((resolve) => {
    execFile(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'],
      (err, stdout) => {
        if (err) return resolve(-1)
        const hits = String(stdout).match(/DeepSeek Harness\.exe/gi)
        resolve(hits ? hits.length : 0)
      },
    )
  })
}

function portOpen(port, timeout = 1200) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* 忽略 */
      }
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function launch(exe) {
  try {
    const child = spawn(exe, [], {
      detached: true,
      stdio: 'ignore',
      // cwd 必须是程序自己的目录：从计划任务拉起时 cwd 是 System32，
      // Electron 应用在那里常找不到资源、直接静默退出。
      cwd: dirname(exe),
    })
    child.on('error', (err) => log(`[waker] spawn 出错: ${err.message}`))
    child.on('exit', (code) => log(`[waker] 子进程退出 code=${code} pid=${child.pid}`))
    child.unref()
    log(`[waker] 已 spawn pid=${child.pid}`)
    return true
  } catch (err) {
    log(`[waker] spawn 抛错: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/**
 * 通过计划任务拉起 DSH。
 *
 * 为什么绕这一道：唤醒器自己跑在 run-hidden.py 的 Job Object 里，从 Job 内
 * detach 子进程可能被拒；而计划任务由服务端启动，天然脱离该 Job，且任务动作
 * 自带"19387 没通才启动"的守卫（--launch-if-down），不会起第二个实例。
 */
function launchViaTask(taskName) {
  return new Promise((resolve) => {
    try {
      execFile('schtasks.exe', ['/run', '/TN', taskName], (err, _stdout, stderr) => {
        if (err) {
          log(`[waker] schtasks /run 失败: ${err.message} ${String(stderr).trim()}`)
          resolve(false)
        } else {
          log(`[waker] 已请求计划任务启动: ${taskName}`)
          resolve(true)
        }
      })
    } catch (err) {
      log(`[waker] schtasks 抛错: ${err instanceof Error ? err.message : String(err)}`)
      resolve(false)
    }
  })
}

function render(message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  return message.map((seg) => (seg?.type === 'text' ? String(seg.data?.text ?? '') : '')).join('')
}

async function send(bot, userId, text) {
  await bot.send('send_private_msg', { user_id: userId, message: [{ type: 'text', data: { text } }] })
  log(`[waker] -> ${userId}: ${text.slice(0, 80)}`)
}

const clientLog = {
  info: (m) => log(`[onebot info] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
  warn: (m) => log(`[onebot warn] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
  error: (m) => log(`[onebot error] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
}

async function onMessage(bot, ev) {
  try {
    if (ev?.post_type !== 'message' || ev?.message_type !== 'private') return
    const qq = Number(ev.user_id)
    if (!CFG.allow.includes(qq)) return
    const text = render(ev.message ?? ev.raw_message).trim()
    if (!text.startsWith(CFG.prefix)) return
    const head = text.slice(CFG.prefix.length).trim().split(/\s+/)[0]
    if (!['start', '启动', '开机'].includes(head)) return

    // DSH 在跑：让插件回答，唤醒器保持沉默，避免双回复
    const beatAge = pluginHeartbeatAgeMs()
    const procs = await dshProcessCount()

    // 进程数 0 是最硬的判据：直接从"未运行"走，不等心跳过期。
    // 强杀 DSH 时 dispose 不会执行，心跳文件会保留到 mtime 过期（最多 90 秒），
    // 这期间只看心跳会误判成"插件还在"，用户发 #start 就没人应答。
    if (procs > 0 && beatAge !== null && beatAge <= 90000) {
      log(`[waker] 插件心跳 ${Math.round(beatAge / 1000)} 秒前，交给插件回答`)
      return
    }
    log(
      `[waker] 进程 ${procs} 个，插件心跳${
        beatAge === null ? '不存在' : `已过期 ${Math.round(beatAge / 1000)} 秒`
      }，按"DSH 未运行"处理`,
    )

    log(`[waker] ${qq} 要求启动 DSH`)
    await send(bot, qq, `DSH 没在跑，正在启动，最多等 ${CFG.waitSecs} 秒`)

    // 退出点已从代码确认：拿不到 Electron 单实例锁就 quit。
    // 旧实例正在收尾时抢跑必然失败，所以先等进程数归零。
    for (let i = 0; i < 10; i++) {
      const c = await dshProcessCount()
      if (c === 0) break
      log(`[waker] 还有 ${c} 个 DSH 进程在收尾，等 3 秒`)
      await delay(3000)
    }
    // 陈旧锁清理：进程已归零时，删掉 0 字节 lockfile
    if ((await dshProcessCount()) === 0) {
      try {
        const lf = join(homedir(), 'AppData', 'Roaming', '@deepseek-ai', 'dsh-desktop', 'lockfile')
        if (existsSync(lf)) {
          unlinkSync(lf)
          log('[waker] 已清理陈旧 lockfile')
        }
      } catch (err) {
        log(`[waker] 清理 lockfile 失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 启动前心跳的值。只有启动后出现**更新**的心跳，才能证明插件真的加载了。
    // 只看进程数会把"应用窗口起来了、宿主没起来"误判成启动成功：
    // 那种状态下所有 QQ 命令都没人处理，用户看到的就是"回了启动成功，然后没反应"。
    const beatAtLaunch = (() => {
      try {
        return Number(readFileSync(HEARTBEAT, 'utf8').trim()) || 0
      } catch {
        return 0
      }
    })()

    // 最多三轮：每轮启动后观察 40 秒，若进程起了又秒退（拿不到锁）就再试
    const deadline = Date.now() + CFG.waitSecs * 1000
    let waited = 0
    for (let attempt = 1; attempt <= 3; attempt++) {
      const viaTask = await launchViaTask(CFG.task)
      if (!viaTask && !launch(CFG.exe)) {
        await send(bot, qq, `启动失败，检查计划任务或路径：${CFG.exe}`)
        return
      }
      log(`[waker] 第 ${attempt} 轮已发出启动请求`)
      let aliveSeen = false
      const roundEnd = Math.min(Date.now() + 40000, deadline)
      while (Date.now() < roundEnd) {
        await delay(3000)
        waited += 3
        const c = await dshProcessCount()
        if (c > 0) {
          aliveSeen = true
          // 就绪的判据是插件写出了新的心跳，而不是"进程还在"。
          // 桌面端 webserver 用随机端口，端口号每次启动都变，所以也不能拿端口判。
          const beat = (() => {
            try {
              return Number(readFileSync(HEARTBEAT, 'utf8').trim()) || 0
            } catch {
              return 0
            }
          })()
          if (beat > beatAtLaunch) {
            log(`[waker] 插件已加载（${c} 个进程，心跳 ${beat}，${waited}s，第 ${attempt} 轮）`)
            await send(bot, qq, `DSH 起来了（${c} 个进程，插件已连上，等了 ${waited} 秒）`)
            return
          }
        } else {
          aliveSeen = false
        }
        if (aliveSeen && c === 0) {
          log(`[waker] 第 ${attempt} 轮：进程起了又退，准备重试`)
          break
        }
      }
    }
    const finalCount = await dshProcessCount()
    const finalBeat = (() => {
      try {
        return Number(readFileSync(HEARTBEAT, 'utf8').trim()) || 0
      } catch {
        return 0
      }
    })()
    log(`[waker] 超时，进程 ${finalCount} 个，心跳${finalBeat > beatAtLaunch ? '有更新' : '没更新'}`)
    await send(
      bot,
      qq,
      finalCount === 0
        ? `等了 ${CFG.waitSecs} 秒：一个进程都没起来 —— 启动动作没生效`
        : finalBeat > beatAtLaunch
          ? `等了 ${CFG.waitSecs} 秒：进程 ${finalCount} 个，插件心跳有更新但没连上 QQ，可能 NapCat 没起来`
          : `等了 ${CFG.waitSecs} 秒：进程 ${finalCount} 个，但插件没加载（心跳没更新）—— 窗口起来了、宿主没起来，去电脑上看一眼`,
    )
  } catch (err) {
    log(`[waker] 处理失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 单实例守卫：占一个本地端口，占不到说明已有唤醒器在跑，直接退出。
 * 必须这么做：VBS 启动的进程是脱离的，计划任务的 Stop 杀不掉它，
 * 装一次就会多一个实例，两个实例会对同一条 #start 各回一次。
 */
async function acquireSingleton() {
  return await new Promise((resolve) => {
    const server = createServer()
    server.once('error', (err) => {
      log(`[waker] 单实例端口被占（${err.code}），已有唤醒器在跑，退出`)
      resolve(null)
    })
    server.listen(CFG.singletonPort, '127.0.0.1', () => {
      log(`[waker] 单实例端口 ${CFG.singletonPort} 已占`)
      resolve(server)
    })
  })
}

async function main() {
  const singleton = await acquireSingleton()
  if (!singleton) process.exit(0)
  // 一次性模式：登录自启用。只在 19387 没通时才启动，避免同一个 profile 起两个实例。
  if (process.argv.includes('--launch-if-down')) {
    const running = (await dshProcessCount()) > 0
    log(`[waker] launch-if-down：${running ? '已有进程，跳过' : '没有进程，启动 DSH'}`)
    if (!running) {
      // 必须经计划任务启动：本进程跑在 run-hidden.py 的 Job 里，
      // 直接 spawn 的子进程会随本进程退出被 kill-on-close 杀掉。
      const ok = await launchViaTask(CFG.task)
      if (!ok) {
        log('[waker] launch-if-down：计划任务启动失败，退回直接 spawn（可能被 Job 杀掉）')
        launch(CFG.exe)
      }
    }
    return
  }
  const probeOnly = process.argv.includes('--probe')
  log(`[waker] 启动 probeOnly=${probeOnly}，当前 DSH 进程数 ${await dshProcessCount()}`)
  let bot
  try {
    bot = await connect({
      baseUrl: CFG.ws,
      log: clientLog,
      reconnection: { enable: true, attempts: 100000, delay: 5000 },
    })
  } catch (err) {
    log(`[waker] 连接失败: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(probeOnly ? 1 : 0)
  }
  log('[waker] 已连上 NapCat')
  if (probeOnly) {
    log('[waker] probe 成功，退出')
    try {
      if (typeof bot.disconnect === 'function') await bot.disconnect()
    } catch {
      /* 忽略 */
    }
    process.exit(0)
  }
  bot.on('message', (ev) => {
    void onMessage(bot, ev)
  })
  log('[waker] 待命')
}

void main()
