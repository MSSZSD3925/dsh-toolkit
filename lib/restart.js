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

export const Config = z.object({
  enabled: z.boolean().default(true).description('启用重启能力（工具与 QQ 的 #restart）'),
  task_name: z.string().default('DSH Restart Now').description('执行重启的计划任务名（由 install-restart.ps1 创建）'),
  launch_task: z.string().default('DSH Start').description('负责把 DSH 拉起来的计划任务名'),
  default_delay_secs: z.number().default(20).description('默认延迟多少秒后重启'),
  min_delay_secs: z.number().default(5).description('允许的最小延迟；低于它会被抬到它'),
  log_path: z.string().default(join(homedir(), '.dsh', 'dsh-restart.log'))
    .description('日志文件，脚本与插件写同一份'),
  request_path: z.string().default(join(homedir(), '.dsh', 'dsh-restart-request.json'))
    .description('请求文件：脚本读它拿延迟与备注'),
  resume_path: z.string().default(join(homedir(), '.dsh', 'dsh-toolkit-resume.json'))
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
    execFile('schtasks.exe', ['/Run', '/TN', taskName], (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, detail: `${err.message} ${String(stderr || '').trim()}`.trim() })
        return
      }
      const out = String(stdout || '').trim()
      resolve({ ok: true, detail: out || 'ok' })
    })
  })
}

/**
 * 自动续跑：给「重启」加一条腿，让被重启打断的任务自己接着干。
 *
 * 记录写在 $DSH_HOME 下（DSH 进程之外），因为重启瞬间进程里什么都留不下。
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

function pickRunningSession(agents) {
  if (!agents || typeof agents.list !== 'function') return ''
  const handles = agents.list()
  let best = ''
  for (const h of handles) {
    const agent = h?.agent ?? h
    const sid = String(agent?.session?.header?.id ?? agent?.id ?? '')
    if (!sid) continue
    if (/idle/i.test(String(agent?.phase ?? ''))) continue
    best = sid
  }
  return best
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
async function resolveResumeAgentOptions(hooks, log, waitMs = 20000) {
  const startedAt = Date.now()
  let warned = false
  for (;;) {
    try {
      const selection = hooks.ctx?.get?.('agentDefaultModel')?.currentSelection?.()
      if (selection?.provider && selection?.model) {
        return {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        }
      }
    } catch (err) {
      if (!warned) log(`读默认模型失败：${err instanceof Error ? err.message : String(err)}`)
      warned = true
    }
    try {
      for (const h of hooks.agents?.list?.() ?? []) {
        const opts = (h?.agent ?? h)?.options
        if (opts?.provider && opts?.model) {
          return {
            provider: opts.provider,
            model: opts.model,
            ...(opts.reasoningEffort === undefined ? {} : { reasoningEffort: opts.reasoningEffort }),
          }
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
  if (n >= max) clearResume(config)

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
        log('拿不到可用的模型选择，放弃续跑（不会用空 agentOptions 去 resume）')
        clearResume(config)
        return
      }
      log(`冷启动 resume 使用的模型：${agentOptions.provider}/${agentOptions.model}`)
      handle = await agents.resume({ resumeSessionId: sid, sessionId: sid, agentOptions })
    }
    const agent = handle?.agent ?? handle
    if (!agent || typeof agent.followup !== 'function') {
      throw new Error(`句柄没有 followup（session ${target}）`)
    }
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    log(`已注入续跑 ${n}/${max} -> ${target}（本次之后剩余 ${Math.max(0, max - n)} 次）`)
  } catch (err) {
    log(`续跑注入失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 排程一次重启。工具与 QQ 的 #restart 都走这里。
 * 返回 { requestedAt, scheduledAt, delaySecs, adjusted, note }
 */
export async function scheduleRestart(config, args) {
  if (!config.enabled) throw new Error('重启能力已在配置里关掉（enabled: false）')
  const raw = Number(args?.delay_secs)
  const delay = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : config.default_delay_secs
  if (delay > 3600) throw new Error('delay_secs 最大 3600 秒')
  const effective = Math.max(delay, config.min_delay_secs)
  const note = typeof args?.note === 'string' ? args.note.trim() : ''
  const resumePrompt = typeof args?.resume_prompt === 'string' ? args.resume_prompt.trim() : ''

  const requestedAt = stamp()
  const scheduledAt = new Date(Date.now() + effective * 1000).toISOString()
  writeFileSync(
    config.request_path,
    JSON.stringify({ requestedAt, scheduledAt, delaySecs: effective, note, pid: process.pid }, null, 2),
    'utf8',
  )
  append(config.log_path, `${requestedAt} [restart] 排程重启：${effective} 秒后，备注=${note || '(无)'}`)

  // 续跑记录要先写：计划任务一旦杀掉进程，本进程就再没机会写了。
  let resume = null
  if (resumePrompt) {
    resume = armResume(config, {
      sessionId: args?.session_id,
      prompt: resumePrompt,
      max: args?.resume_max,
      ttlSecs: args?.resume_ttl_secs,
      scheduledAt,
    })
    append(
      config.log_path,
      `${requestedAt} [restart] 已布置自动续跑：${resume.sessionId}，最多 ${resume.max} 次，` +
        `有效期到 ${new Date(resume.expireAt).toISOString()}`,
    )
  }

  const r = await runTask(config.task_name)
  if (!r.ok) {
    append(config.log_path, `${requestedAt} [restart] 触发计划任务 ${config.task_name} 失败：${r.detail}`)
    throw new Error(
      `触发计划任务「${config.task_name}」失败：${r.detail}\n` +
        `先确认任务存在：Get-ScheduledTask -TaskName '${config.task_name}'；没有就跑一次 install-restart.ps1。`,
    )
  }
  append(config.log_path, `${requestedAt} [restart] 已触发计划任务 ${config.task_name}：${r.detail}`)
  return { requestedAt, scheduledAt, delaySecs: effective, adjusted: effective !== delay, note, resume }
}

function status(config) {
  const pending = existsSync(config.request_path) ? readFileSync(config.request_path, 'utf8').trim() : ''
  let tail = ''
  if (existsSync(config.log_path)) {
    try {
      tail = readFileSync(config.log_path, 'utf8').trim().split(/\r?\n/).slice(-8).join('\n')
    } catch {
      tail = '(日志读不出)'
    }
  }
  return { pending: pending || '', logTail: tail || '(还没有日志)' }
}

export function apply(ctx, config, hooks = {}) {
  const log = (msg) => append(config.log_path, `${stamp()} [restart] ${msg}`)

  ctx.tools.register(
    defineTool({
      name: 'dsh_restart',
      description:
        '重启 DSH 桌面端，让改过的插件、配置、环境变量生效。' +
        'action=schedule（默认）：排程一次重启，delay_secs 秒后由计划任务杀掉全部 DSH 进程并重新拉起；' +
        'action=status：看有没有待执行的请求、最近几行日志。' +
        '注意：重启会中断当前回合，delay_secs 要给回复留出时间（默认 20 秒，最小 5 秒）。',
      parameters: {
        action: {
          type: 'string',
          enum: ['schedule', 'status'],
          description: 'schedule=排程重启（默认），status=查状态',
        },
        delay_secs: {
          type: 'number',
          description: '多少秒后重启，5–3600，默认 20；太小会来不及把回复发出去',
        },
        note: { type: 'string', description: '写进请求文件与日志的备注，例如「装完插件让改动生效」' },
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
            requestedAt: { type: 'string' },
            note: { type: 'string' },
            scheduledAt: { type: 'string' },
            delaySecs: { type: 'number' },
            adjusted: { type: 'boolean' },
            pending: { type: 'string' },
            logTail: { type: 'string' },
            resumeSession: { type: 'string' },
            resumeMax: { type: 'number' },
          },
        },
        render: (_args, value) => {
          if (value.action === 'status') {
            return [
              {
                type: 'text',
                text: `待执行请求：${value.pending ? '\n' + value.pending : '无'}\n最近日志：\n${value.logTail}`,
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
      async execute(args) {
        if (String(args?.action ?? 'schedule') === 'status') {
          return { action: 'status', ...status(config) }
        }
        const wantResume = typeof args?.resume_prompt === 'string' && args.resume_prompt.trim() !== ''
        const sessionId = wantResume ? pickRunningSession(hooks.agents) : ''
        if (wantResume && !sessionId) log('[restart] 没找到运行中的会话，本次不布置续跑，只重启')
        const r = await scheduleRestart(config, {
          ...args,
          resume_prompt: sessionId ? args.resume_prompt : '',
          session_id: sessionId,
        })
        const out = {
          action: 'schedule',
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
