/**
 * dsh-toolkit 的重启那一半：让模型自己把 DSH 重启一遍，让改过的插件、配置生效。
 *
 * 为什么不能直接 kill 自己再 spawn：桌面宿主把子进程挂在 Job Object 上
 * （kill-on-close），宿主一死，从它里面 spawn 出来的助手进程会一起消失，
 * 没人把 DSH 拉回来。真正干活的是计划任务「DSH Restart Now」—— 它由任务计划
 * 服务启动，在 DSH 进程树之外，杀完 DSH 还能继续「等进程清零 → 重新拉起」。
 *
 * 本模块只做三件事：写请求文件（延迟、备注）、触发计划任务、记日志。
 * 计划任务与脚本由 dsh-toolkit/install-restart.ps1 建好，见 README。
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'dsh-toolkit:restart'

/** DSH 的数据目录：优先 $DSH_HOME，与 qq.js 里 dshHome 的取法保持一致。 */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export const Config = z.object({
  enabled: z.boolean().default(true).description('启用重启能力（工具与 QQ 的 #restart）'),
  task_name: z.string().default('DSH Restart Now').description('执行重启的计划任务名（由 install-restart.ps1 创建）'),
  default_delay_secs: z.number().default(20).description('默认延迟多少秒后重启'),
  min_delay_secs: z.number().default(5).description('允许的最小延迟；低于它会被抬到它'),
  log_path: z.string().default(join(dshHome(), 'dsh-restart.log'))
    .description('日志文件，脚本与插件写同一份'),
  request_path: z.string().default(join(dshHome(), 'dsh-restart-request.json'))
    .description('请求文件：脚本读它拿延迟与备注'),
  resume_path: z.string().default(join(dshHome(), 'dsh-toolkit-resume.json'))
    .description('续跑布置记录；插件每次启动读它一次'),
  resume_max: z.number().default(2).description('同一条续跑任务最多自动续跑几次（硬上限 5）'),
  resume_ttl_secs: z.number().default(900).description('续跑布置的有效期（秒），从预计重启时刻算起'),
})

function append(file, text) {
  try {
    appendFileSync(file, text.endsWith('\n') ? text : text + '\n', 'utf8')
  } catch {
    /* 日志写不进去不影响主流程 */
  }
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const hh = p(Math.floor(Math.abs(off) / 60))
  const mm = p(Math.abs(off) % 60)
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${hh}:${mm}`
  )
}

function runTask(taskName) {
  return new Promise((resolve) => {
    const done = (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, detail: `${err.message} ${String(stderr || '').trim()}`.trim() })
        return
      }
      const out = String(stdout || '').trim()
      resolve({ ok: true, detail: out || 'ok' })
    }
    try {
      execFile('schtasks.exe', ['/Run', '/TN', taskName], done)
    } catch (err) {
      done(err, '', '')
    }
  })
}

/**
 * 自动续跑：给「重启」加一条腿，让被重启打断的任务自己接着干。
 *
 * 记录写在 $DSH_HOME（或 ~/.dsh）下、DSH 进程之外，因为重启瞬间进程里什么都留不下。
 * 防死循环靠三层：单条任务最多 resume_max 次；布置有 TTL（过期的记录直接丢）；
 * 另有一份窗口计数器（30 分钟内最多累计 5 次续跑），即使反复重新布置也会被拦。
 */
function readGuard(path) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(j?.runs) ? j.runs.map(Number).filter((n) => Number.isFinite(n)) : []
  } catch {
    return []
  }
}

function writeGuard(path, runs) {
  try {
    writeFileSync(path, JSON.stringify({ runs }, null, 2), 'utf8')
  } catch {
    /* 计数器写不进去不影响主流程 */
  }
}

function clearResume(config) {
  try {
    if (existsSync(config.resume_path)) unlinkSync(config.resume_path)
  } catch {
    /* 删不掉就留着，下次按过期处理 */
  }
}

/** 布置一次续跑，返回 { sessionId, max, expireAt }。 */
function armResume(config, { sessionId, prompt, max, ttlSecs, scheduledAt }) {
  const now = Date.now()
  const guardPath = config.resume_path + '.guard'
  const windowMs = 30 * 60 * 1000
  const hardCap = 5
  const runs = readGuard(guardPath).filter((n) => now - n < windowMs)
  if (!sessionId) {
    throw new Error('没拿到当前会话 id，无法布置自动续跑；只排程重启即可')
  }
  if (runs.length >= hardCap) {
    throw new Error(`最近 30 分钟已自动续跑 ${runs.length} 次，先停下来看日志：${config.log_path}`)
  }
  const maxN = Math.max(1, Math.min(hardCap, Number(max) || config.resume_max))
  const ttl = Math.max(60, Math.min(3600, Number(ttlSecs) || config.resume_ttl_secs))
  const restartAt = new Date(scheduledAt).getTime()
  const rec = {
    sessionId,
    prompt,
    attempts: 0,
    max: maxN,
    armedAt: new Date(now).toISOString(),
    scheduledAt,
    expireAt: (Number.isFinite(restartAt) ? restartAt : now) + ttl * 1000,
  }
  writeFileSync(config.resume_path, JSON.stringify(rec, null, 2), 'utf8')
  return { sessionId, max: maxN, expireAt: rec.expireAt }
}

/**
 * sessionId 写成 "auto" 时用这个：取最近写过的那个会话文件。
 * 用途是"重启后接着刚才那个会话"，布置续跑时拿不到 session id 也有兜底。
 */
function pickMostRecentSession() {
  const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
  let best = null
  try {
    for (const ws of readdirSync(root, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue
      const wsDir = join(root, ws.name)
      let subs = []
      try {
        subs = readdirSync(wsDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const s of subs) {
        if (!s.isDirectory()) continue
        try {
          const st = statSync(join(wsDir, s.name, 'session.v4.jsonl.zstd'))
          if (!best || st.mtimeMs > best.mtimeMs) best = { id: s.name, mtimeMs: st.mtimeMs }
        } catch {
          /* 没有会话文件就跳过 */
        }
      }
    }
  } catch {
    return ''
  }
  return best ? best.id : ''
}

/** 会话文件的最后修改时间，用来在多个活跃会话里挑最近的那个；找不到返回 0。 */
function sessionMtimeOf(sid) {
  const root = join(dshHome(), 'sessions')
  try {
    for (const ws of readdirSync(root, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue
      try {
        return statSync(join(root, ws.name, sid, 'session.v4.jsonl.zstd')).mtimeMs
      } catch {
        /* 不在这个工作区，接着找 */
      }
    }
  } catch {
    /* 没有 sessions 目录 */
  }
  return 0
}

/**
 * 取一个正在跑的会话当续跑目标。
 * 多个会话同时跑时按会话文件 mtime 取最近的，避免「最后一个」随遍历顺序漂移。
 */
function pickRunningSession(agents) {
  if (!agents || typeof agents.list !== 'function') return ''
  const handles = agents.list()
  let best = ''
  let bestAt = -1
  for (const h of handles) {
    const agent = h?.agent ?? h
    const sid = String(agent?.session?.header?.id ?? agent?.id ?? '')
    if (!sid) continue
    if (/idle/i.test(String(agent?.phase ?? ''))) continue
    const at = sessionMtimeOf(sid)
    if (at > bestAt) {
      best = sid
      bestAt = at
    }
  }
  return best
}

/** 会话短编号：去掉 session- 前缀取前 8 位，与 QQ 那边的写法保持一致。 */
export function shortSessionId(id) {
  return String(id ?? '').replace(/^session-/, '').slice(0, 8)
}

/** 与 qq.js 的 isRunningAgent 同一判据：status 优先，退回 phase.kind。 */
function isRunningAgent(agent) {
  if (!agent) return false
  if (typeof agent.status === 'string') return agent.status === 'running'
  const phase = agent.phase
  const kind = typeof phase === 'string' ? phase : phase?.kind
  return !/^(idle|maintenance)$/.test(String(kind ?? ''))
}

function clip(text, max = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 从消息对象里抠正文，兼容 string 与 content 数组两种形状。 */
function messageText(value) {
  const c = value?.content ?? value?.text ?? value
  if (typeof c === 'string') return c.trim()
  if (Array.isArray(c)) {
    return c
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim()
  }
  return ''
}

/** 去掉 qq.js 注入时加的 [来自 QQ …] 说明段。 */
function stripInjected(text) {
  if (!text.startsWith('[来自 QQ ')) return text
  const end = text.indexOf(']\n\n')
  return end >= 0 ? text.slice(end + 3).trim() : text
}

/** 这个会话当前在做的任务：最后一条用户消息；没有就退回最后一条助手消息。 */
function taskOf(agent) {
  const list = agent?.session?.log ?? agent?.session?.eventsSnapshot
  if (!Array.isArray(list)) return ''
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const ev = list[i]
    if (ev?.type !== 'user/message') continue
    const text = stripInjected(messageText(ev?.data?.message ?? ev?.data))
    if (text) return clip(text)
  }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const ev = list[i]
    if (ev?.type !== 'assistant/message') continue
    const text = messageText(ev?.data?.message ?? ev?.data)
    if (text) return clip(`（已回复）${text}`)
  }
  return ''
}

/** 标题：优先 agent 自带，其次读界面的会话投影缓存（与 qq.js 的 readTitle 同源）。 */
function titleOf(agent, sid) {
  const own = agent?.session?.title
  if (typeof own === 'string' && own.trim()) return own.trim()
  try {
    const raw = readFileSync(join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sid}.json`), 'utf8')
    const v = JSON.parse(raw)?.record?.rows?.title?.val
    return typeof v === 'string' ? v.trim() : ''
  } catch {
    return ''
  }
}

/**
 * 列出现在正在跑的会话（可排除调用方自己）。
 * 返回 [{ id, short, title, task, phase }]，供延迟重启与提示文案使用。
 */
export function listRunningSessions(agents, excludeId = '') {
  if (!agents || typeof agents.list !== 'function') return []
  const out = []
  let handles = []
  try {
    handles = agents.list()
  } catch {
    return []
  }
  for (const handle of handles) {
    const agent = handle?.agent ?? handle
    const sid = String(agent?.session?.header?.id ?? agent?.id ?? '')
    if (!sid || sid === excludeId) continue
    if (!isRunningAgent(agent)) continue
    out.push({
      id: sid,
      short: shortSessionId(sid),
      title: titleOf(agent, sid),
      task: taskOf(agent),
      phase: String(agent?.phase?.kind ?? agent?.phase ?? 'running'),
    })
  }
  return out
}

/**
 * 升级或换默认模型后，界面选中的路由可能指向没有凭证的通道（例如 deepseek-official），
 * 冷启动续跑把它原样写进 agentOptions，之后每一轮都在发请求前失败，表现为"静默不回复"。
 * 这里做一层兜底：选中的路由没有对应凭证时，换回账号路由（同模型）。
 */
const FALLBACK_PROVIDER = 'deepseek-account'

function hasKeyedRouteCredential() {
  try {
    const text = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
    // 凭证文件里出现 deepseek-official 且附近有 key 字样，才认为这条路由可用
    return /deepseek-official[\s\S]{0,600}(apiKey|api_key|DEEPSEEK_API_KEY|key\s*:)/i.test(text)
  } catch {
    return false
  }
}

function withCredentialFallback(selection, log) {
  if (!selection?.provider || selection.provider !== 'deepseek-official') return selection
  if (hasKeyedRouteCredential()) return selection
  log(`默认模型路由 ${selection.provider} 没有凭证，续跑改用 ${FALLBACK_PROVIDER}/${selection.model}`)
  return { ...selection, provider: FALLBACK_PROVIDER }
}

/**
 * 冷启动续跑必须先确定模型。
 *
 * agents.resume 不带 agentOptions 时，被恢复的 agent 的 provider/model 是空的，
 * 而提示词段里的 {{model}} 在组装阶段就要取值，取不到就整轮报错、一个请求都不发
 * （现象是会话"卡死"、无法继续对话）。这里取界面当前选中的模型，来源与 GUI
 * 自己 resume 会话时一致：agentDefaultModel.currentSelection()。
 *
 * 启动早期该服务可能还没就绪，所以轮询等待一段时间，而不是一次读不到就放弃。
 */
export async function resolveResumeAgentOptions(hooks, log, waitMs = 20000) {
  const startedAt = Date.now()
  let warned = false
  for (;;) {
    try {
      const selection = hooks.ctx?.get?.('agentDefaultModel')?.currentSelection?.()
      if (selection?.provider && selection?.model) {
        return withCredentialFallback({
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        }, log)
      }
    } catch (err) {
      if (!warned) log(`读默认模型失败：${err instanceof Error ? err.message : String(err)}`)
      warned = true
    }
    try {
      for (const h of hooks.agents?.list?.() ?? []) {
        const opts = (h?.agent ?? h)?.options
        if (opts?.provider && opts?.model) {
          return withCredentialFallback({
            provider: opts.provider,
            model: opts.model,
            ...(opts.reasoningEffort === undefined ? {} : { reasoningEffort: opts.reasoningEffort }),
          }, log)
        }
      }
    } catch {
      /* 没有活着的 agent 可用，继续等默认模型 */
    }
    if (Date.now() - startedAt >= waitMs) return undefined
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/**
 * 冷启动 resume 必须挂上默认 Agent 预设。
 *
 * 不挂预设时被恢复的 agent 只有「全局注册」的工具（插件工具），标准工具集
 * （read/write/edit/bash 等）不会出现，现象就是"基础工具全消失，只剩几个插件工具"。
 * qq.js 的 acquireAgent 一直带着预设；这条续跑路径之前漏了，这里补齐。
 */
async function resolveResumePreset(hooks, log, waitMs = 20000) {
  const startedAt = Date.now()
  let lastError = ''
  for (;;) {
    const presets = hooks.ctx?.get?.('agentPresets')
    if (presets && typeof presets.resolve === 'function' && typeof presets.mount === 'function') {
      try {
        const resolved = await presets.resolve(undefined)
        return {
          agentPreset: resolved.id,
          setup: async (agentCtx) => {
            await presets.mount(agentCtx, resolved.id)
          },
        }
      } catch (err) {
        // 启动早期预设还没注册，resolve 会抛 Unknown agent preset；继续等到超时
        lastError = err instanceof Error ? err.message : String(err)
      }
    } else {
      lastError = 'agentPresets 服务未就绪'
    }
    if (Date.now() - startedAt >= waitMs) {
      log(`预设不可用（${lastError}），续跑不带预设（标准工具可能缺失）`)
      return undefined
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/**
 * 插件启动时调用一次：如果上次排程重启时布置了续跑，就往那个会话里补一条用户消息。
 * 用 agent.followup 而不是新建会话，这样接着的是同一个上下文。
 */
export async function runPendingResume(config, hooks = {}) {
  const log = (msg) => append(config.log_path, `${stamp()} [resume] ${msg}`)
  if (!config.enabled) return
  if (!existsSync(config.resume_path)) return

  let rec = null
  try {
    rec = JSON.parse(readFileSync(config.resume_path, 'utf8'))
  } catch {
    clearResume(config)
    log('记录解析失败，已丢弃')
    return
  }
  if (!rec?.sessionId || !rec?.prompt) {
    clearResume(config)
    log('记录缺字段，已丢弃')
    return
  }

  const now = Date.now()
  if (Number(rec.expireAt) && now > Number(rec.expireAt)) {
    clearResume(config)
    log(`已过期（布置于 ${rec.armedAt}），不再续跑`)
    return
  }

  const max = Math.max(1, Math.min(5, Number(rec.max) || config.resume_max))
  const attempts = Number(rec.attempts) || 0
  if (attempts >= max) {
    clearResume(config)
    log(`已达上限 ${max} 次，不再续跑`)
    return
  }

  const guardPath = config.resume_path + '.guard'
  const windowMs = 30 * 60 * 1000
  const runs = readGuard(guardPath).filter((n) => now - n < windowMs)
  if (runs.length >= 5) {
    clearResume(config)
    log(`最近 30 分钟已续跑 ${runs.length} 次，触发防死循环上限，停止`)
    return
  }

  const n = attempts + 1
  rec.attempts = n
  rec.lastAt = new Date(now).toISOString()
  writeFileSync(config.resume_path, JSON.stringify(rec, null, 2), 'utf8')
  writeGuard(guardPath, [...runs, now])

  const text =
    `（自动续跑 ${n}/${max}：DSH 刚重启完成，这条是插件替你补的，不是用户的新指令。）\n` +
    `继续上次被打断的任务：${rec.prompt}\n` +
    `做完了就用一句话说明结论并停下；不要为了「继续」再排一次重启。`

  const target = rec.sessionId === 'auto' ? pickMostRecentSession() : rec.sessionId
  if (!target) {
    clearResume(config)
    log('目标是 auto 但没找到最近活动的会话，放弃续跑')
    return
  }
  if (target !== rec.sessionId) log(`目标会话由 auto 解析为 ${target}`)

  const agents = hooks.agents
  try {
    const sid = SessionId(target)
    let handle = null
    try {
      handle = agents.get(sid)
    } catch (err) {
      log(`agents.get 抛错：${err instanceof Error ? err.message : String(err)}`)
    }
    if (!handle) {
      const agentOptions = await resolveResumeAgentOptions(hooks, log)
      if (!agentOptions) {
        log('拿不到可用的模型选择，本次不续跑（记录保留，下次启动再试；到期自动清）')
        return
      }
      const preset = await resolveResumePreset(hooks, log)
      log(
        `冷启动 resume 使用的模型：${agentOptions.provider}/${agentOptions.model}` +
          `，预设：${preset?.agentPreset ?? '(无)'}`,
      )
      handle = await agents.resume({ resumeSessionId: sid, sessionId: sid, agentOptions, ...(preset ?? {}) })
    }
    const agent = handle?.agent ?? handle
    if (!agent || typeof agent.followup !== 'function') {
      throw new Error(`句柄没有 followup（session ${target}）`)
    }
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    // 注入完立刻落盘，否则刚注入的这条消息还在内存里，崩一次就丢了
    // flush 要的是 session 对象（qq.js 里也是 sessions.flush(agent.session)），不是无参调用
    try {
      const session = agent.session
      if (session && typeof hooks.sessions?.flush === 'function') await hooks.sessions.flush(session)
    } catch (err) {
      log(`sessions.flush 失败（不影响续跑）：${err instanceof Error ? err.message : String(err)}`)
    }
    // 记录要留到注入成功之后再删：先删再注入的话，注入失败就彻底没法重试了
    if (n >= max) clearResume(config)
    log(`已注入续跑 ${n}/${max} -> ${target}（本次之后剩余 ${Math.max(0, max - n)} 次）`)
  } catch (err) {
    log(`续跑注入失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 排程一次重启。工具与 QQ 的 #restart 都走这里。
 *
 * 默认行为（wait=true）：别的会话还在跑时先不排程，只记一条「延后重启」，
 * 每 2 秒看一次，等这些会话全部回到 idle 再真正写请求文件、触发计划任务。
 * force=true（QQ 二次确认 / 工具带有效令牌）则不看别的会话，立刻排程。
 *
 * 返回：正常排程 { requestedAt, scheduledAt, delaySecs, adjusted, note, resume }；
 * 被延后 { deferred: true, requestedAt, delaySecs, adjusted, note, busy }。
 */
export async function scheduleRestart(config, args, hooks = {}) {
  if (!config.enabled) throw new Error('重启能力已在配置里关掉（enabled: false）')
  const raw = Number(args?.delay_secs)
  const delay = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : config.default_delay_secs
  if (delay > 3600) throw new Error('delay_secs 最大 3600 秒')
  const effective = Math.max(delay, config.min_delay_secs)
  const note = typeof args?.note === 'string' ? args.note.trim() : ''
  const resumePrompt = typeof args?.resume_prompt === 'string' ? args.resume_prompt.trim() : ''
  const sessionId = String(args?.session_id ?? '')
  const force = args?.force === true
  const requestedAt = stamp()

  // 新请求覆盖旧的延后状态：否则旧的那条会在任务清空时再触发一次，变成连续重启。
  if (deferred) {
    const old = deferred
    deferred = null
    stopDeferPoller()
    append(
      config.log_path,
      `${requestedAt} [restart] 新的重启请求覆盖了此前等待中的延后（原等 ${old.busy?.length ?? 0} 个任务）`,
    )
  }

  const busy = force ? [] : listRunningSessions(hooks.agents, sessionId)
  if (busy.length) {
    deferred = {
      delaySecs: effective,
      adjusted: effective !== delay,
      note,
      resumePrompt,
      sessionId,
      resumeMax: args?.resume_max,
      resumeTtl: args?.resume_ttl_secs,
      requestedAt,
      excludeId: sessionId,
      busy,
      at: Date.now(),
    }
    ensureDeferPoller(config, hooks)
    append(
      config.log_path,
      `${requestedAt} [restart] 检测到 ${busy.length} 个任务在跑，重启延后：` +
        busy.map((item) => item.short).join('、'),
    )
    return { deferred: true, requestedAt, delaySecs: effective, adjusted: effective !== delay, note, busy }
  }

  return triggerRestart(config, {
    delaySecs: effective,
    adjusted: effective !== delay,
    note,
    resumePrompt,
    sessionId,
    resumeMax: args?.resume_max,
    resumeTtl: args?.resume_ttl_secs,
    requestedAt,
  })
}

// ── 强制重启的二次确认令牌 ────────────────────────────────────────────────────
// 只存在内存里，60 秒过期：拿到令牌 = 调用方已经看过运行中任务清单，
// 再带回来一次才算用户确认过。QQ 那边用「#restart force → #restart confirm」两步。
const FORCE_TOKEN_TTL_MS = 60_000
const forceTokens = new Map()

function issueForceToken() {
  const now = Date.now()
  for (const [key, value] of forceTokens) {
    if (now - value.at > FORCE_TOKEN_TTL_MS) forceTokens.delete(key)
  }
  let token = ''
  do {
    token = Math.random().toString(36).slice(2, 6).toUpperCase()
  } while (forceTokens.has(token))
  forceTokens.set(token, { at: now })
  return token
}

function consumeForceToken(token) {
  const key = String(token ?? '').trim().toUpperCase()
  const hit = forceTokens.get(key)
  if (!hit) return false
  forceTokens.delete(key)
  return Date.now() - hit.at <= FORCE_TOKEN_TTL_MS
}

/** 运行中会话清单的可读文本：短编号 + 标题 + 正在做的任务。 */
function busyLines(busy) {
  return (busy ?? [])
    .map((item) => `${item.short}  ${item.title || '(无标题)'}${item.task ? `  任务：${item.task}` : ''}`)
    .join('\n')
}

// ── 延后重启：等别的任务跑完再触发 ────────────────────────────────────────────
// 只在插件进程内记账。重启一旦真的发生，这条记录也就没用了；
// 期间 DSH 若被手动关掉，没有重启可做，记录随进程消失即可。
let deferred = null
let deferredTimer = null

function stopDeferPoller() {
  if (deferredTimer) {
    clearInterval(deferredTimer)
    deferredTimer = null
  }
}

function ensureDeferPoller(config, hooks) {
  if (deferredTimer) return
  deferredTimer = setInterval(() => {
    void tickDeferred(config, hooks)
  }, 2000)
  if (typeof deferredTimer.unref === 'function') deferredTimer.unref()
}

async function tickDeferred(config, hooks) {
  if (!deferred) {
    stopDeferPoller()
    return
  }
  const busy = listRunningSessions(hooks.agents, deferred.excludeId)
  if (busy.length) {
    deferred.busy = busy
    return
  }
  const job = deferred
  deferred = null
  stopDeferPoller()
  const waited = Math.round((Date.now() - job.at) / 1000)
  append(
    config.log_path,
    `${stamp()} [restart] 延后结束：等了 ${waited} 秒，${job.busy?.length ?? 0} 个任务都已结束，开始重启`,
  )
  try {
    const r = await triggerRestart(config, job)
    try {
      hooks.notify?.(
        `DSH 的延后重启已开始：等了 ${waited} 秒，${job.busy?.length ?? 0} 个任务都结束了，` +
          `${r.delaySecs} 秒后关闭并自动拉起。`,
      )
    } catch {
      /* 通知失败不影响重启 */
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    append(config.log_path, `${stamp()} [restart] 延后重启触发失败：${message}`)
    try {
      hooks.notify?.(`延后重启触发失败：${message}\n需要的话发 #restart 重新排一次。`)
    } catch {
      /* 通知失败不影响主流程 */
    }
  }
}

/** 取消延后的重启；返回是否真的取消了一条。 */
export function cancelDeferredRestart(config) {
  if (!deferred) return false
  const job = deferred
  deferred = null
  stopDeferPoller()
  append(config.log_path, `${stamp()} [restart] 已取消延后重启（原本等 ${job.busy?.length ?? 0} 个任务）`)
  return true
}

/** 当前延后状态的可读文本（没有就返回空串）。 */
export function describeDeferred() {
  if (!deferred) return ''
  const rows = (deferred.busy ?? []).map(
    (item) => `${item.short}  ${item.title || '(无标题)'}${item.task ? `  任务：${item.task}` : ''}`,
  )
  return [
    `重启已延后，等这 ${rows.length} 个任务跑完：`,
    ...rows,
    `已等 ${Math.round((Date.now() - deferred.at) / 1000)} 秒。`,
  ].join('\n')
}

/** 真正写请求文件、布置续跑、触发计划任务。 */
async function triggerRestart(config, job) {
  const { delaySecs, note, resumePrompt, sessionId, resumeMax, resumeTtl, requestedAt } = job
  const scheduledAt = new Date(Date.now() + delaySecs * 1000).toISOString()
  writeFileSync(
    config.request_path,
    JSON.stringify({ requestedAt, scheduledAt, delaySecs, note, pid: process.pid }, null, 2),
    'utf8',
  )
  append(config.log_path, `${requestedAt} [restart] 排程重启：${delaySecs} 秒后，备注=${note || '(无)'}`)

  // 续跑记录要先写：计划任务一旦杀掉进程，本进程就再没机会写了。
  let resume = null
  try {
    if (resumePrompt) {
      resume = armResume(config, {
        sessionId,
        prompt: resumePrompt,
        max: resumeMax,
        ttlSecs: resumeTtl,
        scheduledAt,
      })
      append(
        config.log_path,
        `${requestedAt} [restart] 已布置自动续跑：${resume.sessionId}，最多 ${resume.max} 次，` +
          `有效期到 ${new Date(resume.expireAt).toISOString()}`,
      )
    }
  } catch (err) {
    // 续跑没布置成，重启也不会发生：把请求文件收掉，免得 status 永远显示「待执行」
    try {
      if (existsSync(config.request_path)) unlinkSync(config.request_path)
    } catch {
      /* 删不掉就留着，status 会按过期清理 */
    }
    throw err
  }

  const r = await runTask(config.task_name)
  if (!r.ok) {
    append(config.log_path, `${requestedAt} [restart] 触发计划任务 ${config.task_name} 失败：${r.detail}`)
    // 重启不会有下文了：清掉请求文件，并且别让这条续跑记录在 TTL 内被下次启动当成「刚重启完」注入
    clearResume(config)
    try {
      if (existsSync(config.request_path)) unlinkSync(config.request_path)
    } catch {
      /* 删不掉就留着，status 会按过期清理 */
    }
    throw new Error(
      `触发计划任务「${config.task_name}」失败：${r.detail}\n` +
        `先确认任务存在：Get-ScheduledTask -TaskName '${config.task_name}'；没有就跑一次 install-restart.ps1。`,
    )
  }
  append(config.log_path, `${requestedAt} [restart] 已触发计划任务 ${config.task_name}：${r.detail}`)
  return { requestedAt, scheduledAt, delaySecs, adjusted: job.adjusted === true, note, resume }
}

function status(config) {
  // 请求文件只在 restart.ps1 成功路径被删；重启失败或走了别的路径时会一直留着，
  // 这里把明显过期的清掉，免得永远显示「待执行」把模型带偏。
  let pending = ''
  if (existsSync(config.request_path)) {
    let rec = null
    try {
      rec = JSON.parse(readFileSync(config.request_path, 'utf8'))
    } catch {
      rec = null
    }
    const at = rec ? Date.parse(String(rec.scheduledAt ?? '')) : NaN
    const stale = !rec || (Number.isFinite(at) && Date.now() - at > 10 * 60 * 1000)
    if (stale) {
      try {
        unlinkSync(config.request_path)
      } catch {
        /* 删不掉就算了，下次再清 */
      }
      append(
        config.log_path,
        `${stamp()} [restart] 请求文件已过期，清掉（计划于 ${rec?.scheduledAt ?? '无法解析'}）`,
      )
    } else {
      pending = JSON.stringify(rec, null, 2)
    }
  }
  let tail = ''
  if (existsSync(config.log_path)) {
    try {
      tail = readFileSync(config.log_path, 'utf8').trim().split(/\r?\n/).slice(-8).join('\n')
    } catch {
      tail = '(日志读不出)'
    }
  }
  return { pending: pending || '', logTail: tail || '(还没有日志)', waiting: describeDeferred() }
}

export function apply(ctx, config, hooks = {}) {
  const log = (msg) => append(config.log_path, `${stamp()} [restart] ${msg}`)

  ctx.tools.register(
    defineTool({
      name: 'dsh_restart',
      description:
        '重启 DSH 桌面端，让改过的插件、配置、环境变量生效。' +
        'action=schedule（默认）：排程一次重启，delay_secs 秒后由计划任务杀掉全部 DSH 进程并重新拉起。' +
        '默认会先看其他对话有没有任务在跑：有的话不立刻排程，而是延迟到它们全部结束再重启，' +
        '并在返回里列出这些对话的短编号、标题与任务。' +
        '如果用户明确要求立刻重启：先问用户（ask_user_question），同意后再调用一次，' +
        '带 force=true 和上次返回的 force_token 做二次确认。' +
        'action=cancel：取消还在等待的延后重启。action=status：看待执行请求、延后状态与最近日志。' +
        '注意：重启会中断当前回合，delay_secs 要给回复留出时间（默认 20 秒，最小 5 秒）。',
      parameters: {
        action: {
          type: 'string',
          enum: ['schedule', 'status', 'cancel'],
          description: 'schedule=排程重启（默认），status=查状态，cancel=取消延后中的重启',
        },
        delay_secs: {
          type: 'number',
          description: '多少秒后重启，5–3600，默认 20；太小会来不及把回复发出去',
        },
        note: { type: 'string', description: '写进请求文件与日志的备注，例如「装完插件让改动生效」' },
        force: {
          type: 'boolean',
          description: 'true = 不等其他任务，立刻重启；必须配 force_token（先调用一次拿到令牌并问过用户）',
        },
        force_token: {
          type: 'string',
          description: '强制重启的二次确认令牌：上一次返回的 token，60 秒内有效',
        },
        resume_prompt: {
          type: 'string',
          description:
            '可选：重启完成后自动叫醒当前会话接着做这件事（一句话，写清目标与验收）。' +
            '只在需要它自己继续时不填别的也行；最多续跑 resume_max 次',
        },
        resume_max: { type: 'number', description: '自动续跑最多几次，1–5，默认 2' },
        resume_ttl_secs: { type: 'number', description: '续跑布置的有效期（秒），60–3600，默认 900' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true },
            status: { type: 'string' },
            requestedAt: { type: 'string' },
            note: { type: 'string' },
            scheduledAt: { type: 'string' },
            delaySecs: { type: 'number' },
            adjusted: { type: 'boolean' },
            pending: { type: 'string' },
            logTail: { type: 'string' },
            waiting: { type: 'string' },
            busy: { type: 'string' },
            token: { type: 'string' },
            hint: { type: 'string' },
            resumeSession: { type: 'string' },
            resumeMax: { type: 'number' },
          },
        },
        render: (_args, value) => {
          if (value.action === 'status') {
            const waiting = value.waiting ? `\n${value.waiting}` : ''
            return [
              {
                type: 'text',
                text: `待执行请求：${value.pending ? '\n' + value.pending : '无'}${waiting}\n最近日志：\n${value.logTail}`,
              },
            ]
          }
          if (value.action === 'cancel') {
            return [
              {
                type: 'text',
                text: value.status === 'cancelled' ? '已取消延后的重启，其他任务照常跑。' : '当前没有延后的重启。',
              },
            ]
          }
          if (value.status === 'waiting') {
            return [
              {
                type: 'text',
                text:
                  `检测到 ${value.busy ? value.busy.split('\n').length : 0} 个其他对话正在运行，` +
                  `重启已延后到它们全部完成（完成前每 2 秒检查一次）：\n${value.busy}\n\n` +
                  `如果用户现在就要重启：先用 ask_user_question 问用户是否强制重启（问题里带上上面这份清单），` +
                  `用户同意后再调用 dsh_restart，action=schedule，force=true，force_token=${value.token}（60 秒内有效）。`,
              },
            ]
          }
          if (value.status === 'need_confirmation') {
            return [
              {
                type: 'text',
                text:
                  `强制重启需要二次确认：\n${value.busy}\n\n` +
                  `如果用户已经明确同意立刻重启，再调用一次 dsh_restart，action=schedule，force=true，` +
                  `force_token=${value.token}（60 秒内有效）。还没问过用户就先问，不要替用户决定。`,
              },
            ]
          }
          const resumeLine = value.resumeMax
            ? `\n重启后会自动叫醒会话 ${value.resumeSession} 继续（最多 ${value.resumeMax} 次）。`
            : ''
          const when = value.adjusted
            ? `已排程，${value.delaySecs} 秒后重启（原值低于下限，已抬高）`
            : `已排程，${value.delaySecs} 秒后重启`
          return [
            {
              type: 'text',
              text: `${when}，预计 ${value.scheduledAt}。${resumeLine}\n重启会中断当前回合；DSH 重新起来后用 ${'#list'} 之类的命令确认插件都加载了。`,
            },
          ]
        },
      },
      async execute(args, exec) {
        const action = String(args?.action ?? 'schedule')
        if (action === 'status') {
          return { action: 'status', status: 'status', ...status(config) }
        }
        if (action === 'cancel') {
          return { action: 'cancel', status: cancelDeferredRestart(config) ? 'cancelled' : 'idle' }
        }

        const wantResume = typeof args?.resume_prompt === 'string' && args.resume_prompt.trim() !== ''
        // exec.agent 是发起这次工具调用的会话；优先用它，免得把「自己」算成需要等待的任务。
        const callerId = String(exec?.agent?.session?.header?.id ?? exec?.agent?.id ?? '')
        const sessionId = callerId || (wantResume ? pickRunningSession(hooks.agents) : '')
        if (wantResume && !sessionId) log('[restart] 没找到运行中的会话，本次不布置续跑，只重启')

        const busy = listRunningSessions(hooks.agents, sessionId)
        const wantForce = args?.force === true
        if (busy.length && wantForce) {
          if (!consumeForceToken(args?.force_token)) {
            return {
              action: 'schedule',
              status: 'need_confirmation',
              token: issueForceToken(),
              busy: busyLines(busy),
            }
          }
        }

        const r = await scheduleRestart(
          config,
          {
            ...args,
            resume_prompt: sessionId ? args?.resume_prompt : '',
            session_id: sessionId,
            force: busy.length ? wantForce : false,
          },
          hooks,
        )
        if (r.deferred) {
          return {
            action: 'schedule',
            status: 'waiting',
            requestedAt: r.requestedAt,
            delaySecs: r.delaySecs,
            busy: busyLines(r.busy),
            token: issueForceToken(),
          }
        }
        const out = {
          action: 'schedule',
          status: 'scheduled',
          requestedAt: r.requestedAt,
          scheduledAt: r.scheduledAt,
          delaySecs: r.delaySecs,
          adjusted: r.adjusted,
        }
        if (r.resume) {
          out.resumeSession = r.resume.sessionId
          out.resumeMax = r.resume.max
        }
        return out
      },
    }),
  )

  log(`[apply] enter enabled=${config.enabled} task=${config.task_name}`)
}
