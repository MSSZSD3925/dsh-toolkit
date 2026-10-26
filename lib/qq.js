/**
 * dsh-qq-router —— 用 QQ 远程驾驶【本 profile 里已经存在的会话】。
 *
 * 与 dsh-1bot 的根本区别：
 *   dsh-1bot 是独立 profile（onebot）里的适配器，每条 QQ 聊天新建一个自己的会话，
 *   而且把会话藏在 $DSH_HOME/sessions-hidden —— 因为一份会话日志只能有一个写入者，
 *   跨进程写就损坏。所以它永远够不到 desktop profile 里你正在用的会话。
 *   本插件跑在 desktop profile【同一个进程】里，因此：
 *     ctx.agents.get(id) 拿到的是 UI 正在用的那个 agent 实例，
 *     往它里面 followup 一条 source.kind='user' 的消息，就等于你在电脑前打字。
 *
 * 调用方式全部照抄 dsh-1bot（它在本机 DSH 版本上跑通）：
 *   - 连接：  connect({ baseUrl, accessToken, log, reconnection })
 *   - 事件：  client.on('message', (event) => …)
 *   - 发送：  client.send('send_private_msg', { user_id, message: [{type:'text',data:{text}}] })
 *   - 驱动：  agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
 *   - 工具：  ctx.tools.register(defineTool({ … }))
 *
 * 路由表来源（只读，不碰会话日志）：
 *   $DSH_HOME/sessions/<cwd-dir>/<sessionId>/session.v4.jsonl.zstd   → 会话 id 与最后活动
 *   $DSH_HOME/storages/session_projcache/sessions/<sessionId>.json   → record.rows.title.val 标题
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { appendFile, readFile, readdir, stat } from 'node:fs/promises'
import { homedir, networkInterfaces, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { createConnection, createServer as createNetServer } from 'node:net'
import { createSocket as createUdpSocket } from 'node:dgram'
import { createZstdDecompress } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { connect } from 'onebot.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveResumeAgentOptions } from './restart.js'

export const name = 'dsh-toolkit:qq'

/** 先等这些服务就绪再 apply（与 dsh-1bot 同形）。 */
export const inject = ['tools', 'agents', 'sessions']

export const Config = z.object({
  enabled: z.boolean().default(true).description('启用桥接'),
  ws_url: z.string().default('ws://127.0.0.1:3001').description('NapCat 正向 WebSocket 地址'),
  access_token: z.string().default('').description('OneBot access token（可选）'),
  allow_users: z.array(z.number()).default([]).description('允许发远程指令的 QQ 号白名单；空 = 谁都进不来'),
  prefix: z.string().default('#').description('指令前缀'),
  default_session: z.string().default('').description('没写路由时进哪个会话；留空则必须显式写路由'),
  workspace: z.string().default('')
    .description('QQ 新建会话时用的工作目录；留空则沿用最近一个主会话记录的 cwd，再没有就不写 cwd'),
  aliases: z.array(z.string()).default([]).description('路由别名，形如 "mod=session-xxxx"'),
  list_limit: z.number().default(12).description('#list 列出多少个会话'),
  route_ttl_secs: z.number().default(1800).description('#list 的编号有效多久（秒）'),
  reply_chunk_size: z.number().default(4000).description('单条 QQ 消息最大字数'),
  silence_notice: z.boolean().default(true).description('一轮结束但模型没调 onebot_send 时，回一条提示'),
  hint: z.string().default('').description('注入时的说明模板，可用 {qq} 与 {text}；留空用内置模板'),
  napcat_path: z.string().default('D:\\Program Files\\NapCatQQ Desktop\\NapCatQQ-Desktop.exe')
    .description('#start 在 NapCat 没起来时拉起它用的可执行文件路径'),
  start_wait_secs: z.number().default(90).description('#start 拉起 NapCat 后最多等多少秒'),
  dsh_exe: z.string().default('D:\\DSH\\DeepSeek Harness.exe')
    .description('DSH 桌面端可执行文件路径；qq_waker 安装的启动任务与登录自启都指向它'),
  dsh_port: z.number().default(19387)
    .description('已停用：桌面端 webserver 改成随机端口后不再用固定端口判断存活；保留此键只为兼容旧配置'),
  pair_link_autosend: z.boolean().default(true)
    .description('连上 QQ 后自动把一个新的手机配对链接发到白名单'),
  pair_link_address: z.string().default('')
    .description('取配对链接时请求的局域网地址；留空由远程插件按 publicBaseUrl/局域网自行选择'),
  link_proxy_port: z.number().default(62566)
    .description('远程链接用的本机代理端口：监听所有网卡，转发到 DSH Web'),
  link_public_host: z.string().default('')
    .description('链接里写的地址：IP、host:port，或 https:// 开头的完整地址；留空自动挑本机局域网 IP'),
  approval_remote: z.boolean().default(true)
    .description('把审批请求（approval/request）推送到 QQ，可用 #y / #n 远程决定'),
  approval_timeout_secs: z.number().default(300)
    .description('QQ 侧最多等多少秒；超时就把这条审批整条交回界面卡片'),
  questions_remote: z.boolean().default(true)
    .description('把提问（ask_user_question）推送到 QQ，可用 #answer 远程回答'),
  question_timeout_secs: z.number().default(1800)
    .description('QQ 侧最多等多少秒；超时就把提问交回界面（之后迟到的 #answer 仍会交给模型）'),
  progress_secs: z.number().default(0)
    .description('启动后自动推送会话进度的间隔秒数（0 = 关闭；也可以用 #progress 开/关）'),
})

const CHUNK_DELAY_MS = 300

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 把 OneBot 消息体渲染成纯文本（text 段保留，其余段降级为 [type k=v]）。 */
function messageToText(message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  return message
    .map((seg) => {
      if (!seg || !seg.type) return ''
      if (seg.type === 'text') return String(seg.data?.text ?? '')
      if (seg.type === 'at') return `@${seg.data?.qq ?? ''}`
      const kv = Object.entries(seg.data ?? {})
        .map(([k, v]) => ` ${k}=${String(v)}`)
        .join('')
      return `[${seg.type}${kv}]`
    })
    .join('')
}

function chunk(text, maxChars) {
  if (!(maxChars > 0) || text.length <= maxChars) return [text]
  const out = []
  for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars))
  return out
}

function shortId(id) {
  return id.replace(/^session-/, '').slice(0, 8)
}

/** 从一条消息对象里抠出正文，兼容几种可能的形状。 */
function pickText(message) {
  const c = message?.content ?? message?.text ?? message?.message?.content
  if (typeof c === 'string') return c.trim()
  if (Array.isArray(c)) {
    return c
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim()
  }
  return ''
}

/** 去掉注入时加的 QQ 说明段，只留用户原话。 */
function stripHint(text) {
  if (!text.startsWith('[来自 QQ ')) return text
  const end = text.indexOf(']\n\n')
  return end >= 0 ? text.slice(end + 3).trim() : text
}

/**
 * 读一个 agent 的最近消息。last 是最后一条有正文的消息（不分角色），
 * lastAssistant 是最后一条助手回复，lastUser 是用户自己发的最后一条；
 * 都读不到时 shape 带诊断信息。
 * 数据源是会话事件日志（session.log）：只有 assistant/message 与 user/message
 * 两类事件的 data.message 里才有正文 —— 依据 @deepseek-ai/dsh-agent-preset-registry
 * 的事件类型描述，不再猜字段名。
 */
function readLatest(agent) {
  const session = agent?.session
  const log = session?.log ?? session?.eventsSnapshot
  const list = Array.isArray(log) ? log : null
  if (!list) {
    return {
      last: '',
      lastAssistant: '',
      lastUser: '',
      shape: 'session=[' + Object.keys(session ?? {}).join(',') + '] log=' + typeof log,
    }
  }
  const rows = []
  for (const ev of list) {
    const type = ev?.type
    if (type !== 'assistant/message' && type !== 'user/message') continue
    // assistant/message 的正文在 data.message 里，user/message 的正文直接就是 data，
    // 两者结构不同（见 dsh-agent-preset-registry 的事件类型描述），所以要分开取。
    const text = pickText(ev?.data?.message ?? ev?.data)
    if (text) rows.push({ text: stripHint(text), role: type === 'assistant/message' ? 'assistant' : 'user' })
  }
  const last = rows.length ? rows[rows.length - 1].text : ''
  const asst = [...rows].reverse().find((r) => r.role === 'assistant')
  const user = [...rows].reverse().find((r) => r.role === 'user')
  return {
    last,
    lastAssistant: asst ? asst.text : '',
    lastUser: user ? user.text : '',
    shape: 'events=' + list.length + ' msgs=' + rows.length + ' roles=[' + [...new Set(rows.map((r) => r.role))].join(',') + ']',
  }
}

/**
 * 取最近一轮的报错原文（没有就返回空串）。
 *
 * 一轮在提示词组装阶段失败时，会话里一条助手消息都不会新增；这时兜底逻辑若照常
 * 回「最新助手回复」，发回去的是上一轮的旧内容，看起来就像"取错了会话"。
 * 所以先看最后一条 turn/end 的 reason：kind=error 就把错误原文报回去。
 */
function lastTurnError(agent) {
  const session = agent?.session
  const list = session?.log ?? session?.eventsSnapshot
  if (!Array.isArray(list)) return ''
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const ev = list[i]
    if (ev?.type !== 'turn/end') continue
    const reason = ev?.data?.reason
    if (reason?.kind !== 'error') return ''
    return String(reason?.error?.message ?? '未知错误')
  }
  return ''
}

export function apply(ctx, config, hooks = {}) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const logPath = join(dshHome, 'dsh-qq-router.log')
  const log = (message) => {
    try {
      void appendFile(logPath, `${new Date().toISOString()} ${message}\n`)
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  log(`[apply] enter enabled=${config.enabled} prefix=${JSON.stringify(config.prefix)} allow=${JSON.stringify(config.allow_users)}`)
  if (!config.enabled) {
    log('[apply] disabled by config')
    return
  }

  // cordis 要求先注入才能取服务；用动态注入而不是写进 inject，
  // 这样 webserver 不在时插件照常加载，只是配对链接功能不可用。
  let webServerRef = null
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (inner) => {
        webServerRef = inner.webServer ?? null
        const p = webServerRef && typeof webServerRef.port === 'number' ? webServerRef.port : '未知'
        log(`[pair] webServer 已注入，端口 ${p}`)
      })
    } catch (err) {
      log(`[pair] webServer 注入失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  if (!agents) log('[apply] WARN: 拿不到 agents 服务')

  const prefix = String(config.prefix ?? '#')
  const allow = new Set((config.allow_users ?? []).map((n) => Number(n)))

  // ── 远程审批 ──────────────────────────────────────────────────────────────
  // approval/request 是 waterfall：谁先返回结果就算谁的。桌面端的 answerer 一旦接管
  // 就进去等点击，QQ 这边再也看不到这条审批 —— 所以本监听器必须 prepend 抢在最前。
  // 但抢到后不能把界面卡死：立刻 next() 把下游放出去，界面卡片照常弹，
  // 两边并行等，谁先给出有效结果用谁的；超时就把决定权整条交回下游。
  const approvals = new Map() // code -> { resolve, timer, label }
  let approvalSeq = 0
  const APPROVAL_YES = ['y', 'yes', 'allow', 'ok', '允许', '同意', '批准']
  const APPROVAL_NO = ['n', 'no', 'deny', 'reject', '拒绝', '否决', '不准']

  // 提权开关：sid -> { agent, sid, at, qq }。本轮内审批一律自动放行，回合结束撤销。
  const ESCALATE_WORDS = ['escalate', '提权']
  const escalations = new Map()
  let escalatePending = null

  function nextApprovalCode() {
    approvalSeq = (approvalSeq + 1) % 10000
    let code = String(approvalSeq).padStart(4, '0')
    while (approvals.has(code)) {
      approvalSeq = (approvalSeq + 1) % 10000
      code = String(approvalSeq).padStart(4, '0')
    }
    return code
  }

  /** 审批原因：优先本地化文案（displayReason），退回日志里的英文 reason。 */
  function approvalReasonText(req) {
    const display = req?.displayReason
    if (display && typeof display === 'object') {
      const zh = display.zh ?? display['zh-CN'] ?? display['zh-Hans']
      if (typeof zh === 'string' && zh.trim()) return zh.trim()
      if (typeof display.en === 'string' && display.en.trim()) return display.en.trim()
    }
    return typeof req?.reason === 'string' ? req.reason.trim() : ''
  }

  function approvalSessionText(req) {
    const session = req?.agent?.session
    const id = typeof session?.id === 'string' ? session.id : ''
    const title = typeof session?.title === 'string' ? session.title : ''
    return { id, title }
  }

  function approvalNoticeText(code, req, secs) {
    const { id, title } = approvalSessionText(req)
    const lines = [`【远程审批 ${code}】${req?.toolName ?? '工具'} 想执行一个需要授权的操作`]
    if (id) lines.push(`会话 ${shortId(id)}${title ? ' 「' + title + '」' : ''}`)
    const reason = approvalReasonText(req)
    if (reason) lines.push(`原因：${reason}`)
    lines.push(`本轮内全部放行：发 ${prefix}escalate 再 ${prefix}escalate confirm（需二次确认，回合结束自动恢复）。`)
    lines.push(`${secs} 秒内回 ${prefix}y ${code} 允许，或 ${prefix}n ${code} 拒绝。`)
    lines.push('不回也行：界面上的卡片照旧可以点。')
    return lines.join('\n')
  }

  /** 结算一条待审批；编号不存在时返回 false。 */
  function settleApproval(code, outcome) {
    const entry = approvals.get(code)
    if (!entry) return false
    approvals.delete(code)
    try {
      clearTimeout(entry.timer)
    } catch {
      /* 忽略 */
    }
    entry.resolve({ code, outcome })
    return true
  }

  /** 只有一条待审批时，允许省略编号。 */
  function currentApprovalCode() {
    if (approvals.size === 1) return [...approvals.keys()][0]
    return null
  }

  async function tellApproval(qq, text) {
    try {
      await sendText(qq, text)
    } catch (err) {
      log(`[approval] 发送失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 审批应答方。返回 allowed-once / rejected 表示 QQ 侧已决定；
   * 其余情况一律把决定权交回下游 answerer。
   */
  async function answerApproval(req, next) {
    let downstream
    try {
      downstream = Promise.resolve(next())
    } catch (err) {
      log(`[approval] 下游抛错: ${err instanceof Error ? err.message : String(err)}`)
      return 'unavailable'
    }
    if (!config.approval_remote) return downstream
    if (!bot || allow.size === 0) return downstream

    const secs = Number(config.approval_timeout_secs) || 300
    const code = nextApprovalCode()
    const { id } = approvalSessionText(req)

    // 提权生效期间：这条会话的审批直接按 allowed-once 放行，不再打扰人。
    if (id && escalations.has(id)) {
      log(`[escalate] ${id} 自动放行 ${req?.toolName ?? '工具'}`)
      void downstream.catch(() => {})
      void (async () => {
        for (const uid of allow) {
          await tellApproval(
            uid,
            `【提权生效】${code} ${req?.toolName ?? '工具'} 已自动允许（${shortId(id)} 本轮内不再逐条问）。`,
          )
        }
      })()
      return 'allowed-once'
    }
    let resolveDecided = () => {}
    const decided = new Promise((resolve) => {
      resolveDecided = resolve
    })
    const entry = {
      resolve: resolveDecided,
      timer: null,
      sid: id,
      label: `${req?.toolName ?? '工具'} ${id ? shortId(id) : ''}`.trim(),
    }
    approvals.set(code, entry)

    const clearEntry = () => {
      approvals.delete(code)
      try {
        clearTimeout(entry.timer)
      } catch {
        /* 忽略 */
      }
      if (req?.signal) {
        try {
          req.signal.removeEventListener('abort', onAbort)
        } catch {
          /* 忽略 */
        }
      }
    }
    // 请求被取消（用户关了回合、工具超时）时不再等 QQ，也不要留悬挂的待审批。
    const onAbort = () => resolveDecided({ code, outcome: 'aborted' })
    if (req?.signal) {
      try {
        req.signal.addEventListener('abort', onAbort, { once: true })
      } catch {
        /* 忽略 */
      }
    }

    entry.timer = setTimeout(() => resolveDecided({ code, outcome: 'timeout' }), secs * 1000)
    if (typeof entry.timer?.unref === 'function') entry.timer.unref()

    // 下游只有给出真实结果才参与竞争；unavailable 说明没人在看界面，继续等 QQ。
    const fromDownstream = downstream.then(
      (outcome) =>
        new Promise((resolve) => {
          if (outcome && outcome !== 'unavailable') resolve({ code, outcome })
        }),
      () =>
        new Promise(() => {
          /* 下游失败不参与竞争：交给 QQ 决定或超时交还 */
        }),
    )

    void (async () => {
      for (const uid of allow) {
        await tellApproval(uid, approvalNoticeText(code, req, secs))
      }
    })()

    const first = await Promise.race([decided, fromDownstream])
    clearEntry()
    if (first.outcome === 'timeout' || first.outcome === 'aborted') {
      log(`[approval] ${code} ${first.outcome}，交回界面`)
      return downstream
    }
    log(`[approval] ${code} 由 QQ 决定: ${first.outcome}`)
    const reply = first.outcome === 'allowed-once' ? `已允许 ${code}。` : `已拒绝 ${code}。`
    void (async () => {
      for (const uid of allow) await tellApproval(uid, reply)
    })()
    return first.outcome
  }

  if (typeof ctx.on === 'function') {
    try {
      ctx.on(
        'approval/request',
        (req, next) =>
          answerApproval(req, next).catch((err) => {
            log(`[approval] 应答异常: ${err instanceof Error ? err.message : String(err)}`)
            return 'unavailable'
          }),
        { prepend: true, global: true },
      )
      log('[approval] 已挂 approval/request（prepend），远程审批就绪')
    } catch (err) {
      log(`[approval] 挂载失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    log('[approval] ctx.on 不存在，远程审批未挂')
  }

  // ── 远程提问 ──────────────────────────────────────────────────────────────
  // user-questions/request 与 approval/request 是同一套 waterfall：谁先给出结果算谁的。
  // 桌面端那张提问卡片只是一个 answerer，它一接管就进去等点击，QQ 这边再也看不到这条提问。
  // 所以策略与远程审批一致：prepend 抢在最前，把问题同步发到 QQ，同时把请求原样交给下游
  // （界面卡片照常弹），两边并行等，谁先答听谁的。
  //
  // 与审批不同的两处：
  //   · 这里的返回值就是答案本身 { answers: [{id, selected, custom?}] }，没有「我不处理」
  //     这种占位值 —— 拿不出答案时只能把下游的结果原样交回去（下游没人接会自己按
  //     NO_PROVIDER 收场，askTimed 据此把这一轮放成 pending）。
  //   · 提问有时间上限（工具默认 120 秒）。超时后问题在投影里变成「继续」状态，
  //     这时迟到的 QQ 回答改走 userQuestions.answer() 补投，不再经过 waterfall。
  const asks = new Map() // code -> { code, callId, agent, sessionId, list, submit, askedAt, timer, signal, onAbort }
  let askSeq = 0

  function nextAskCode() {
    askSeq = (askSeq + 1) % 10000
    let code = 'Q' + String(askSeq).padStart(4, '0')
    while (asks.has(code)) {
      askSeq = (askSeq + 1) % 10000
      code = 'Q' + String(askSeq).padStart(4, '0')
    }
    return code
  }

  function clipText(text, max) {
    const s = String(text ?? '').trim()
    return s.length > max ? s.slice(0, max - 1) + '…' : s
  }

  /** 这条提问该发给谁：优先发给把该会话当默认路由的 QQ，没有就发给整个白名单。 */
  function askTargets(sessionId) {
    const owners = []
    for (const [qq, sid] of sticky) if (sid === sessionId) owners.push(qq)
    return owners.length ? owners : [...allow]
  }

  async function tellAsk(qq, text) {
    try {
      await sendText(qq, text)
    } catch (err) {
      log(`[ask] 发送失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function askNoticeText(code, sessionId, title, list, secs) {
    const lines = [
      `【远程提问 ${code}】会话 ${shortId(sessionId)}${title ? ' 「' + clipText(title, 30) + '」' : ''} 等你回答 ${list.length} 个问题`,
      `电脑上的卡片也能答，谁先答听谁的；${secs} 秒内没回答就交回界面。`,
    ]
    list.forEach((q, i) => {
      const options = Array.isArray(q.options) ? q.options : []
      lines.push('')
      lines.push(`Q${i + 1}${q.header ? '[' + clipText(q.header, 12) + '] ' : ' '}${clipText(q.question, 400)}`)
      if (q.detail) lines.push(clipText(q.detail, 400))
      options.forEach((option, j) => {
        lines.push(`  ${j + 1}) ${clipText(option?.label, 100)}${option?.description ? ' —— ' + clipText(option.description, 120) : ''}`)
      })
      if (!options.length) lines.push('  （没有选项，直接写文字）')
      else lines.push(`  （${q.multiSelect ? '多选，可用逗号写多个' : '单选'}）`)
    })
    lines.push('')
    const firstOptions = Array.isArray(list[0]?.options) ? list[0].options : []
    lines.push(
      list.length > 1
        ? `回复：${prefix}answer ${code} 1:2 2:1,3    「题号:选项号」，多题用空格隔开，某题不答就写「题号:」`
        : firstOptions.length
          ? `回复：${prefix}answer ${code} 2   （选项号）；想写自己的话就直接写：${prefix}answer ${code} 就这样办`
          : `回复：${prefix}answer ${code} 你的回答`,
    )
    return lines.join('\n')
  }

  /** 把「1:2 2:1,3」这种回答记号切成 [{no, text}]；没有题号时整段当一段。 */
  function parseAskSpec(spec) {
    const norm = String(spec ?? '')
      .replace(/：/g, ':')
      .replace(/；/g, ';')
      .replace(/，/g, ',')
      .trim()
    const marks = []
    const re = /(\d+)\s*:/g
    let hit = re.exec(norm)
    while (hit) {
      marks.push({ no: Number(hit[1]), start: hit.index, end: re.lastIndex })
      hit = re.exec(norm)
    }
    if (!marks.length) return [{ no: null, text: norm }]
    return marks.map((mark, i) => {
      const stop = i + 1 < marks.length ? marks[i + 1].start : norm.length
      return { no: mark.no, text: norm.slice(mark.end, stop).trim() }
    })
  }

  /** 把 QQ 上的一句话翻成 ask() 认的答案数组：每道题恰好一条，没答的给空选择。 */
  function buildAskAnswers(list, spec) {
    let segments = parseAskSpec(spec)
    if (segments.length === 1 && segments[0].no === null && list.length > 1) {
      segments = segments[0].text.split(/[\s;]+/).filter(Boolean).map((text) => ({ no: null, text }))
    }
    const slots = new Array(list.length).fill(null)
    for (const segment of segments) {
      if (segment.no === null) {
        if (list.length === 1) {
          slots[0] = segment
          continue
        }
        const free = slots.findIndex((slot) => slot === null)
        if (free < 0) throw new Error(`只有 ${list.length} 个问题，多出来一段：${clipText(segment.text, 20)}`)
        slots[free] = segment
        continue
      }
      if (!(segment.no >= 1 && segment.no <= list.length)) {
        throw new Error(`没有第 ${segment.no} 题（共 ${list.length} 题）`)
      }
      if (slots[segment.no - 1]) throw new Error(`第 ${segment.no} 题写了两遍`)
      slots[segment.no - 1] = segment
    }
    const answers = list.map((question, i) => {
      const segment = slots[i]
      if (!segment || !segment.text) return { id: question.id, selected: [] }
      const options = Array.isArray(question.options) ? question.options : []
      if (options.length && /^[\d\s,]+$/.test(segment.text)) {
        const picked = []
        for (const raw of segment.text.split(',').map((s) => s.trim()).filter(Boolean)) {
          const n = Number(raw)
          if (!(n >= 1 && n <= options.length)) {
            throw new Error(`第 ${i + 1} 题只有 ${options.length} 个选项，没有 ${n} 号`)
          }
          const label = String(options[n - 1]?.label ?? '')
          if (label && !picked.includes(label)) picked.push(label)
        }
        if (!picked.length) throw new Error(`第 ${i + 1} 题没读出选项号`)
        if (!question.multiSelect && picked.length > 1) throw new Error(`第 ${i + 1} 题是单选，只能选一个`)
        return { id: question.id, selected: picked }
      }
      return { id: question.id, selected: [], custom: segment.text }
    })
    if (!answers.some((answer) => answer.selected.length || answer.custom !== undefined)) {
      throw new Error('没读出任何回答')
    }
    return answers
  }

  function askUsage(code, count) {
    return count > 1 ? `${prefix}answer ${code} 1:2 2:1,3` : `${prefix}answer ${code} 2`
  }

  /** 清掉一条待答记录的定时器/监听器；表里的条目由调用方决定要不要删。 */
  function releaseAsk(entry) {
    if (!entry) return
    if (entry.timer) {
      try {
        clearTimeout(entry.timer)
      } catch {
        /* 忽略 */
      }
      entry.timer = null
    }
    if (entry.signal && entry.onAbort) {
      try {
        entry.signal.removeEventListener('abort', entry.onAbort)
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 提问应答方：QQ 先答就用 QQ 的，其余情况把决定权原样交回下游。 */
  async function mirrorAsk(req, next) {
    const downstream = Promise.resolve().then(() => next())
    if (!config.questions_remote) return downstream
    if (!bot || allow.size === 0) return downstream

    const agent = req?.agent
    const callId = req?.wait?.callId
    const list = Array.isArray(req?.questions) ? req.questions : []
    if (!agent || !callId || !list.length) return downstream
    const sessionId = String(agent?.session?.header?.id ?? agent?.id ?? '')

    // 老条目顺手清一清，别让表无限长。
    const cutoff = Date.now() - 2 * 60 * 60 * 1000
    for (const [code, entry] of asks) {
      if (entry.askedAt && entry.askedAt < cutoff) {
        releaseAsk(entry)
        asks.delete(code)
      }
    }

    const secs = Number(config.question_timeout_secs) || 1800
    const code = nextAskCode()
    let resolveDecided = () => {}
    const decided = new Promise((resolve) => {
      resolveDecided = resolve
    })
    const entry = {
      code,
      callId,
      agent,
      sessionId,
      list,
      askedAt: Date.now(),
      timer: null,
      signal: req?.signal ?? null,
      onAbort: null,
      submit: (answers) => resolveDecided({ outcome: 'answered', answers }),
    }
    asks.set(code, entry)

    entry.onAbort = () => resolveDecided({ outcome: 'aborted' })
    if (entry.signal) {
      try {
        if (entry.signal.aborted) entry.onAbort()
        else entry.signal.addEventListener('abort', entry.onAbort, { once: true })
      } catch {
        /* 忽略 */
      }
    }
    entry.timer = setTimeout(() => resolveDecided({ outcome: 'timeout' }), secs * 1000)
    if (typeof entry.timer?.unref === 'function') entry.timer.unref()

    // 下游只有真的给出答案才参与竞争；失败（没人接）就不参与，安静等 QQ。
    const fromDownstream = downstream.then(
      (value) => ({ outcome: 'downstream', value }),
      () =>
        new Promise(() => {
          /* 下游没人接：继续等 QQ 或超时 */
        }),
    )

    void (async () => {
      try {
        const title = await readTitle(sessionId)
        const text = askNoticeText(code, sessionId, title, list, secs)
        for (const uid of askTargets(sessionId)) await tellAsk(uid, text)
        log(`[ask] ${code} 已同步到 QQ（${sessionId}，${list.length} 题）`)
      } catch (err) {
        log(`[ask] ${code} 通知失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    })()

    const first = await Promise.race([decided, fromDownstream])
    releaseAsk(entry)
    entry.submit = null

    if (first.outcome === 'answered') {
      asks.delete(code)
      log(`[ask] ${code} 由 QQ 回答`)
      void (async () => {
        for (const uid of askTargets(sessionId)) await tellAsk(uid, `已在 QQ 提交 ${code} 的答案。`)
      })()
      return { answers: first.answers }
    }
    if (first.outcome === 'downstream') {
      asks.delete(code)
      log(`[ask] ${code} 已在界面回答`)
      void (async () => {
        for (const uid of askTargets(sessionId)) await tellAsk(uid, `提问 ${code} 已经在电脑上回答过了。`)
      })()
      return first.value
    }
    // 超时或被取消：条目留着，迟到的 #答 走 userQuestions.answer() 补投。
    log(`[ask] ${code} ${first.outcome}，交回界面`)
    return downstream
  }

  if (typeof ctx.on === 'function') {
    try {
      ctx.on(
        'user-questions/request',
        (req, next) =>
          mirrorAsk(req, next).catch((err) => {
            log(`[ask] 应答异常: ${err instanceof Error ? err.message : String(err)}`)
            throw err
          }),
        { prepend: true, global: true },
      )
      log('[ask] 已挂 user-questions/request（prepend），远程提问就绪')
    } catch (err) {
      log(`[ask] 挂载失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    log('[ask] ctx.on 不存在，远程提问未挂')
  }

  /** 这条提问还在投影里等着吗（已在界面答过/被取消的就没必要再答）。 */
  function askStillOpen(entry) {
    try {
      const projections = ctx.get?.('sessionProjections')
      const view = projections?.stateOf?.(entry.agent?.session, 'userQuestions')
      const active = view?.questions?.active
      if (!Array.isArray(active)) return true
      return active.some((item) => item.callId === entry.callId)
    } catch {
      return true
    }
  }

  /** #答：把 QQ 上的回答交给那条提问（前台还在等就直接交，等过了就补投）。 */
  async function answerAskFromQq(qq, rest) {
    for (const [code, entry] of asks) {
      if (askStillOpen(entry)) {
        entry.projected = true
        continue
      }
      // 插件自己发起的提问（如 #testask）没有 tool/call 投影记录，查不到不等于已经结束
      if (!entry.projected) continue
      releaseAsk(entry)
      asks.delete(code)
    }
    const pending = [...asks.values()]
    if (!pending.length) {
      await sendText(qq, `现在没有等你回答的提问。（${prefix}ap 看审批，${prefix}running 看在跑的会话）`)
      return
    }

    const words = String(rest ?? '').trim().split(/\s+/).filter(Boolean)
    let code = null
    if (words.length && /^q\d+$/i.test(words[0])) code = words.shift().toUpperCase()
    const entry = code ? asks.get(code) : pending.length === 1 ? pending[0] : null
    if (!entry) {
      const rows = pending.map((item) => `${item.code}  ${shortId(item.sessionId)}  ${item.list.length} 题`)
      await sendText(
        qq,
        [
          code ? `没有 ${code} 这个提问。` : `有 ${pending.length} 个待回答的提问，得带编号。`,
          '等你回答的提问：',
          ...rows,
          '',
          `回复：${prefix}answer <编号> ` + (pending[0].list.length > 1 ? '1:2 2:1,3' : '2'),
        ].join('\n'),
      )
      return
    }

    const spec = words.join(' ').trim()
    if (!spec) {
      await sendText(qq, `用法：${askUsage(entry.code, entry.list.length)}；也可以直接写文字当自定义回答。`)
      return
    }

    let answers
    try {
      answers = buildAskAnswers(entry.list, spec)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await sendText(qq, `这句回答没看懂：${message}\n\n用法：${askUsage(entry.code, entry.list.length)}`)
      return
    }

    const summary = answers
      .map((answer, i) => `${i + 1}) ${answer.custom !== undefined ? answer.custom : answer.selected.length ? answer.selected.join('、') : '（跳过）'}`)
      .join('\n')

    if (typeof entry.submit === 'function') {
      const submit = entry.submit
      entry.submit = null
      asks.delete(entry.code)
      releaseAsk(entry)
      log(`[ask] ${entry.code} 由 QQ 回答: ${summary.replace(/\n/g, ' | ')}`)
      submit(answers)
      await sendText(qq, `已提交答案给 ${shortId(entry.sessionId)}：\n${summary}`)
      return
    }

    // 前台等待已经结束（超时/取消/界面已答）：走迟到回答通道补投给模型。
    const service = ctx.get?.('userQuestions')
    if (!service || typeof service.answer !== 'function') {
      await sendText(qq, '这条提问的前台等待已经结束，而且拿不到 userQuestions 服务，答不上了。')
      return
    }
    let ok = false
    try {
      ok = Boolean(await service.answer(entry.agent, entry.callId, { answers }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`[ask] ${entry.code} 补投失败: ${message}`)
      await sendText(qq, `提交失败：${message}`)
      return
    }
    asks.delete(entry.code)
    releaseAsk(entry)
    await sendText(
      qq,
      ok
        ? `已把答案补交给 ${shortId(entry.sessionId)}（前台等待早结束了，作为迟到回答进入模型）：\n${summary}`
        : `这条提问已经不在等待（超时太久 / 已在电脑上答过 / 被取消），答案没交出去：\n${summary}`,
    )
  }

  /**
   * #testask：不借任何会话，插件直接发一条多选提问，端到端验证 QQ 提问通路。
   * 走的是和模型调 ask_user_question 完全相同的 waterfall，区别只是发起方是插件自己。
   */
  async function testAskOnce(qq) {
    const service = ctx.get?.('userQuestions')
    if (!service || typeof service.ask !== 'function') {
      await sendText(qq, '拿不到 userQuestions 服务，测不了（这个 profile 可能没装提问服务）。')
      return
    }
    const live = liveSessions()
    if (!live.length) {
      await sendText(qq, '现在没有任何活着的会话 agent，提问需要一个活的 agent 承载：先跟某个会话说句话再来试。')
      return
    }
    // 优先用这个 QQ 的默认路由，其次随便挑一个活着的（ask 要求是运行时根 agent）。
    const roots = typeof agents.roots === 'function' ? agents.roots() : []
    const pool = roots.length ? live.filter((item) => roots.includes(item.agent)) : live
    const usable = pool.length ? pool : live
    const current = sticky.get(qq) ?? config.default_session ?? ''
    const want = current ? (await resolveRoute(current).catch(() => null)) ?? current : ''
    const target = usable.find((item) => item.sid === want) ?? usable[0]

    const callId = `qqtest-${Date.now().toString(36)}`
    const questions = [
      {
        id: 'qq_test',
        header: '自检',
        question: 'QQ 远程提问自检：下面几个里，你最想给远程 QQ 再加哪些能力？',
        detail: '多选，选几个都行。这条提问由插件直接发起，不经过任何模型。',
        multiSelect: true,
        options: [
          { label: '图片/文件回传', description: '把截图、生成的文档直接发到 QQ' },
          { label: '语音回答', description: '在 QQ 发语音就能回答提问' },
          { label: '会话进度推送', description: '定时把在跑会话的进展推到 QQ' },
        ],
      },
    ]
    await sendText(qq, `开始自检（${shortId(target.sid)}）：这就发一条多选提问，按提示回 ${prefix}answer 即可。`)
    void (async () => {
      try {
        const result = await service.ask({ questions, agent: target.agent, wait: { callId } })
        const answers = Array.isArray(result?.answers) ? result.answers : []
        const text = answers
          .map((answer) => `${answer.id}: ${(answer.selected ?? []).join('、') || '（跳过）'}${answer.custom !== undefined ? ' / ' + answer.custom : ''}`)
          .join('\n')
        log(`[ask] 自检完成 ${callId}: ${text.replace(/\n/g, ' | ')}`)
        await sendText(qq, `自检完成，收到的答案：\n${text}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log(`[ask] 自检失败 ${callId}: ${message}`)
        await sendText(qq, `自检没走完：${message}`)
      }
    })()
  }

  // ── 出站文件 / 图片 ──────────────────────────────────────────────────────
  function expandHome(p) {
    const raw = String(p ?? '')
      .trim()
      .replace(/^["']|["']$/g, '')
    if (!raw) return ''
    if (raw === '~') return homedir()
    const tilde = raw.slice(0, 2); if (tilde === '~' + String.fromCharCode(92) || tilde === '~/') return join(homedir(), raw.slice(2))
    return raw
  }

  /** 把本机文件/图片发到 QQ（走 NapCat 的 upload_private_file）。 */
  async function sendFileTo(userId, pathText, caption) {
    const target = expandHome(pathText)
    if (!target) throw new Error('没给文件路径')
    if (!existsSync(target)) throw new Error(`文件不存在：${target}`)
    const info = statSync(target)
    if (!info.isFile()) throw new Error(`这不是文件：${target}`)
    if (info.size > 100 * 1024 * 1024) {
      throw new Error(`文件太大（${(info.size / 1048576).toFixed(1)} MB，上限 100 MB）`)
    }
    if (caption && String(caption).trim()) await sendText(userId, String(caption).trim())
    const segs = target.split('/')
    let name = segs[segs.length - 1]
    const cut = name.lastIndexOf(String.fromCharCode(92))
    if (cut >= 0) name = name.slice(cut + 1)
    if (!name) name = 'file'
    try {
      await sendRaw('upload_private_file', { user_id: userId, file: target, name })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`发送失败（NapCat 需要支持 upload_private_file）：${message}`)
    }
    log(`[file] -> ${userId} ${name} (${info.size} bytes)`)
    return { name, size: info.size }
  }

  async function fileFromQq(qq, rest) {
    const spec = String(rest ?? '').trim()
    if (!spec) {
      await sendText(qq, `用法：${prefix}file <本地文件路径>\n例：${prefix}file D:\shot.png\n支持图片和普通文件，上限 100 MB。`)
      return
    }
    try {
      const { name, size } = await sendFileTo(qq, spec)
      await sendText(qq, `已发送 ${name}（${(size / 1024).toFixed(1)} KB）。`)
    } catch (err) {
      await sendText(qq, `发不出去：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── 会话进度推送 ────────────────────────────────────────────────────────
  let progressTimer = null
  let progressSecs = 0

  function progressLines() {
    const live = liveSessions().filter((item) => item.running)
    if (!live.length) return ['现在没有在跑的会话。']
    return live.map((item) => {
      let title = ''
      try {
        title = readTitle(item.sid)
      } catch {
        title = ''
      }
      let latest = ''
      try {
        latest = clipText(String(readLatest(item.agent) ?? '').replace(/\s+/g, ' ').trim(), 120)
      } catch {
        latest = ''
      }
      if (!latest) latest = '（这一轮还没有输出）'
      const head = shortId(item.sid) + (title ? ` 「${clipText(title, 24)}」` : '')
      return `${head}\n  ${latest}`
    })
  }

  async function pushProgress(prefixText) {
    if (!bot) return
    const body = [prefixText, ...progressLines()].filter(Boolean).join('\n')
    for (const uid of allow) await sendText(uid, body)
  }

  function stopProgress() {
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = null
    progressSecs = 0
  }

  function startProgress(secs) {
    stopProgress()
    progressSecs = secs
    progressTimer = setInterval(() => {
      pushProgress(`【进度推送 · 每 ${secs} 秒】`).catch((err) => {
        log(`[progress] 推送失败: ${err instanceof Error ? err.message : String(err)}`)
      })
    }, secs * 1000)
    if (typeof progressTimer?.unref === 'function') progressTimer.unref()
    log(`[progress] 已开启，每 ${secs} 秒推送一次`)
  }

  async function progressFromQq(qq, rest) {
    const word = String(rest ?? '').trim().toLowerCase()
    if (!word) {
      await sendText(
        qq,
        [
          `进度推送：${progressSecs ? `每 ${progressSecs} 秒一次` : '当前关闭'}`,
          `用法：${prefix}progress 30 开启（10–3600 秒）；${prefix}progress off 关闭；${prefix}progress now 立刻看一次`,
        ].join('\n'),
      )
      return
    }
    if (word === 'off' || word === 'stop' || word === '0' || word === '关') {
      stopProgress()
      await sendText(qq, '进度推送已关闭。')
      return
    }
    const secs = Number(word)
    if (!Number.isFinite(secs) || secs <= 0) {
      await pushProgress('【进度快照】')
      return
    }
    const clamped = Math.max(10, Math.min(3600, Math.round(secs)))
    startProgress(clamped)
    await sendText(qq, `已开启：每 ${clamped} 秒把在跑会话的最新输出推到 QQ（${prefix}progress off 关掉）。`)
  }

  const aliasMap = new Map()
  for (const entry of config.aliases ?? []) {
    const i = String(entry).indexOf('=')
    if (i > 0) aliasMap.set(String(entry).slice(0, i).trim(), String(entry).slice(i + 1).trim())
  }

  const sessionsRoot = join(dshHome, 'sessions')
  const cacheRoot = join(dshHome, 'storages', 'session_projcache', 'sessions')

  // ── 路由表 ────────────────────────────────────────────────────────────────
  let bot = null
  let table = { builtAt: 0, byIndex: new Map(), byShort: new Map(), items: [] }
  const sticky = new Map() // qq -> sessionId（#set 设定的默认会话）
  const statePath = join(dshHome, 'dsh-qq-router-state.json')
  try {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(statePath, 'utf8'))?.sticky ?? {})) {
      if (typeof v === 'string' && v) sticky.set(Number(k), v)
    }
    if (sticky.size) log(`[state] 恢复默认路由 ${sticky.size} 条`)
  } catch {
    /* 首次运行没有状态文件 */
  }
  const persistSticky = () => {
    try {
      writeFileSync(statePath, JSON.stringify({ sticky: Object.fromEntries(sticky) }, null, 2))
    } catch (err) {
      log(`[state] 写入失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const pendingTurns = new Map() // qq -> 待回话的轮次数
  const sentThisTurn = new Set() // qq -> 本轮模型是否已主动发过

  async function readTitle(id) {
    try {
      const raw = await readFile(join(cacheRoot, `${id}.json`), 'utf8')
      const title = JSON.parse(raw)?.record?.rows?.title?.val
      return typeof title === 'string' ? title : ''
    } catch {
      return ''
    }
  }

  const headerCache = new Map() // sessionId -> { mtime, depth, cwd }
  let knownCwd = '' // 最近一次从会话头里读到的 cwd，供 #new 建会话时沿用

  /**
   * 取 zstd 文件解压后的第一行（会话头）。
   *
   * 不能靠帧头算长度：这些会话文件用的是"流式帧"，Frame_Content_Size 字段缺省，
   * 只能边解压边收，拿到第一个换行就停。只喂前 64 KB，避免为一行头读整份日志。
   */
  function firstLineOfZstd(buf) {
    return new Promise((resolve) => {
      const decomp = createZstdDecompress()
      let text = ''
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        try {
          decomp.destroy()
        } catch {
          /* 忽略 */
        }
        resolve(value)
      }
      decomp.on('data', (chunk) => {
        text += chunk.toString('utf8')
        const nl = text.indexOf('\n')
        if (nl >= 0) finish(text.slice(0, nl))
        else if (text.length > 65536) finish(text.slice(0, 65536))
      })
      decomp.on('error', () => finish(text || null))
      decomp.on('end', () => finish(text || null))
      decomp.end(buf.subarray(0, Math.min(buf.length, 65536)))
      setTimeout(() => finish(text || null), 3000).unref?.()
    })
  }

  /**
   * 会话头里的 delegationDepth（0 = 主会话，>=1 = 子智能体）与 cwd。
   * 读不到 depth 时返回 null(按主会话处理)；cwd 顺带记进 knownCwd，给 #new 建会话当工作目录。
   */
  async function readHeaderInfo(sessionDir, sessionId, mtime) {
    const cached = headerCache.get(sessionId)
    if (cached && cached.mtime === mtime) {
      if (cached.cwd) knownCwd = cached.cwd
      return cached
    }
    const info = { mtime, depth: null, cwd: '' }
    try {
      const buf = await readFile(join(sessionDir, 'session.v4.jsonl.zstd'))
      const line = await firstLineOfZstd(buf)
      const head = line ? JSON.parse(line) : null
      if (head && typeof head.delegationDepth === 'number') info.depth = head.delegationDepth
      if (head && typeof head.cwd === 'string' && head.cwd) info.cwd = head.cwd
    } catch {
      /* 读不到就按主会话、无 cwd 处理 */
    }
    headerCache.set(sessionId, info)
    if (info.cwd) knownCwd = info.cwd
    return info
  }

  /**
   * 已归档会话 id 集合。
   * 归档状态由界面存在 storages/workspace.json 的 global.archivedSessionIds 里，
   * 里面是 "session-<uuid>"，而会话目录名是裸 uuid，两种都记一份方便比对。
   */
  let archivedCache = { readAt: 0, ids: new Set() }
  let archivedSkipped = 0

  async function readArchivedIds() {
    if (Date.now() - archivedCache.readAt < 3000) return archivedCache.ids
    const ids = new Set()
    try {
      const raw = await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8')
      const list = JSON.parse(raw)?.global?.archivedSessionIds
      if (Array.isArray(list)) {
        for (const id of list) {
          if (typeof id !== 'string') continue
          ids.add(id)
          if (id.startsWith('session-')) ids.add(id.slice('session-'.length))
        }
      }
    } catch {
      /* 读不到就当没有归档会话 */
    }
    archivedCache = { readAt: Date.now(), ids }
    return ids
  }

  async function listSessions(limit) {
    const out = []
    archivedSkipped = 0
    const archived = await readArchivedIds()
    let projectDirs = []
    try {
      projectDirs = await readdir(sessionsRoot, { withFileTypes: true })
    } catch {
      return out
    }
    for (const project of projectDirs) {
      if (!project.isDirectory()) continue
      const projectDir = join(sessionsRoot, project.name)
      let sessionDirs = []
      try {
        sessionDirs = await readdir(projectDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const session of sessionDirs) {
        if (!session.isDirectory()) continue
        const sessionDir = join(projectDir, session.name)
        let mtime = 0
        try {
          mtime = (await stat(join(sessionDir, 'session.v4.jsonl.zstd'))).mtimeMs
        } catch {
          try {
            mtime = (await stat(sessionDir)).mtimeMs
          } catch {
            mtime = 0
          }
        }
        const { depth, cwd } = await readHeaderInfo(sessionDir, session.name, mtime)
        // 子智能体（delegationDepth >= 1）不进路由表，避免把编号浪费在子会话上。
        // 读不到深度时按主会话处理，宁可多列也不漏。
        if (typeof depth === 'number' && depth > 0) continue
        // 已归档的会话在界面里是收起来的，路由表也不列，省得编号被它们占掉。
        if (archived.has(session.name)) {
          archivedSkipped += 1
          continue
        }
        out.push({
          id: session.name,
          project: project.name.replace(/^--|--$/g, ''),
          mtime,
          depth,
          cwd,
          title: await readTitle(session.name),
        })
      }
    }
    out.sort((a, b) => b.mtime - a.mtime)
    // limit 传 Infinity 表示取全量（路由表与翻页都基于全量编号）
    if (!Number.isFinite(limit)) return out
    return out.slice(0, Math.max(1, limit))
  }

  async function refreshTable() {
    // 路由表按全量建，编号才与 #list 翻页显示的一致
    const items = await listSessions(Infinity)
    const byIndex = new Map()
    const byShort = new Map()
    items.forEach((item, i) => {
      byIndex.set(String(i + 1), item.id)
      byShort.set(shortId(item.id), item.id)
    })
    table = { builtAt: Date.now(), byIndex, byShort, items }
    log(`[table] built ${items.length} sessions`)
    return table
  }

  async function tableFresh() {
    const ttl = (Number(config.route_ttl_secs) || 1800) * 1000
    if (!table.items.length || Date.now() - table.builtAt > ttl) await refreshTable()
    return table
  }

  /** 解析一个路由记号：别名 / #list 编号 / 短 id / 完整 id / 前缀匹配。 */
  async function resolveRoute(token) {
    const t = String(token ?? '').trim()
    if (!t) return config.default_session || null
    if (aliasMap.has(t)) return aliasMap.get(t)
    if (t === 'default' || t === '默认') return config.default_session || null
    const tab = await tableFresh()
    if (tab.byIndex.has(t)) return tab.byIndex.get(t)
    if (tab.byShort.has(t)) return tab.byShort.get(t)
    if (/^[A-Za-z0-9-]{6,}$/.test(t)) {
      const all = await listSessions(200)
      const hit =
        all.find((x) => x.id === t) ||
        all.find((x) => shortId(x.id) === t) ||
        all.find((x) => x.id.startsWith(t))
      if (hit) return hit.id
    }
    return null
  }

  function fmtTime(ms) {
    if (!ms) return '未知'
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  async function renderTable(page = 1) {
    const tab = await refreshTable()
    const all = tab.items
    if (!all.length) return '没找到任何会话。'
    const pageSize = Math.max(1, Number(config.list_limit) || 12)
    const pages = Math.max(1, Math.ceil(all.length / pageSize))
    const current = Math.min(Math.max(1, Math.floor(Number(page)) || 1), pages)
    const start = (current - 1) * pageSize
    const lines = all.slice(start, start + pageSize).map((item, offset) => {
      const title = item.title || '(无标题)'
      return `${start + offset + 1}) ${title}\n     ${shortId(item.id)} · ${fmtTime(item.mtime)}`
    })
    return [
      `可用会话（共 ${all.length} 个，已排除子智能体${archivedSkipped ? `与 ${archivedSkipped} 个已归档会话` : ''}；第 ${current}/${pages} 页）：`,
      ...lines,
      '',
      current < pages ? `${prefix}list ${current + 1}  看下一页` : `${prefix}list 1  回到第一页`,
      `用法：${prefix}<编号|别名|短id> 要说的内容`,
      `例：${prefix}2 继续把编码那个问题修完`,
    ].join('\n')
  }

  function helpText() {
    return [
      'QQ → DSH 远程驾驶',
      `${prefix}list [页码]  列出会话与路由（已排除子智能体和已归档会话；编号会随活动变，别名和短 id 才稳）`,
      `${prefix}new        新建一个对话并设为默认路由`,
      `${prefix}check      新建对话做一次自检，结论发回 QQ`,
      `${prefix}restart [秒] 重启 DSH（默认 15 秒后），改完插件用它生效`,
      `${prefix}set <路由>   设定默认会话，重启 DSH 也不丢`,
      `${prefix}start      查两者状态；NapCat 没起来就拉起它并等登录`,
      `${prefix}link       取一个手机能打开的网页链接（局域网/隧道，本次运行有效）`,
      `${prefix}ap         列出等你决定的审批（工具要授权的操作）`,
      `${prefix}y <编号>   允许这条审批；${prefix}n <编号> 拒绝（只有一条时可省编号）`,
      `${prefix}escalate [路由]  本轮提权：当轮所有审批自动允许，回合结束恢复原权限（要再发 ${prefix}escalate confirm）`,
      `${prefix}answer <编号> 1:2  回答提问（ask_user_question 会同步到 QQ；也可以直接写文字）`,
      `${prefix}file <路径>    把本机文件/图片发到 QQ`,
      `${prefix}progress [秒|off]  定时推送在跑会话的最新输出`,
      `${prefix}stop [路由]  停掉正在输出的会话（同客户端停止按钮；只有一个在跑时可省路由）`,
      `${prefix}testask    自检：让插件自己发一个多选提问（测 ${prefix}answer 用）`,
      `${prefix}<路由> 内容   把内容注入指定会话`,
      `${prefix}内容        注入默认会话`,
      `${prefix}running    列出正在运行的会话`,
      `${prefix}msg [路由]    该会话最新的一条助手回复`,
      `${prefix}last [路由]   该会话里你自己发的最后一条`,
      `${prefix}status     连接状态与当前路由`,
      '',
      '消息会作为「你本人发送的普通消息」注入目标会话，',
      '电脑上那个会话照常继续，UI 里也显示成你发的。',
      '模型回话靠它主动调 onebot_send；没调的话插件会把该会话最新回复自动带回。',
      '',
      '命令打错（比如 #lisy）或编号写错时，只回这份用法，不会把错字发给 AI。',
    ].join('\n')
  }

  /** 命令词表：用于给打错的命令找最接近的那个。 */
  const COMMAND_WORDS = [
    'list', 'new', 'check', 'set', 'use', 'link', 'pin', 'ap', 'y', 'n',
    'start', 'running', 'msg', 'last', 'status', 'help', 'restart',
    'answer', 'ans', 'stop', 'file', 'progress', 'testask', 'escalate',
  ]

  function editDistance(a, b) {
    const m = a.length
    const n = b.length
    if (!m) return n
    if (!n) return m
    let prev = Array.from({ length: n + 1 }, (_, j) => j)
    for (let i = 1; i <= m; i += 1) {
      const cur = [i]
      for (let j = 1; j <= n; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      }
      prev = cur
    }
    return prev[n]
  }

  /**
   * 给打错的命令找最接近的命令名；差太远或本来就是它自己就返回 null。
   * 只认纯 ASCII 词，中文内容不参与匹配。
   */
  function nearestCommand(word) {
    const w = word.toLowerCase()
    let best = null
    let bestD = Infinity
    for (const c of COMMAND_WORDS) {
      const d = editDistance(w, c)
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    if (best !== w && bestD <= 2) return best
    return null
  }

  // ── 出站 ──────────────────────────────────────────────────────────────────
  async function sendRaw(action, params) {
    if (!bot) throw new Error('OneBot 未连接')
    if (typeof bot.send === 'function') return bot.send(action, params)
    if (typeof bot[action] === 'function') return bot[action](params)
    throw new Error('OneBot 客户端没有可用的发送方法')
  }

  async function sendText(userId, text) {
    const body = String(text ?? '')
    if (!body.trim()) return
    const max = Number(config.reply_chunk_size) || 4000
    const parts = chunk(body, max)
    for (let i = 0; i < parts.length; i += 1) {
      await sendRaw('send_private_msg', {
        user_id: userId,
        message: [{ type: 'text', data: { text: parts[i] } }],
      })
      if (i < parts.length - 1) await delay(CHUNK_DELAY_MS)
    }
    log(`[send] -> ${userId} (${body.length} chars, ${parts.length} part(s))`)
  }

  // ── 注入 ──────────────────────────────────────────────────────────────────
  function buildHint(qq, text) {
    const custom = String(config.hint ?? '')
    if (custom.trim()) {
      return custom.split('{qq}').join(String(qq)).split('{text}').join(text)
    }
    return (
      `[来自 QQ ${qq} 的远程指令，已注入到本会话；它与你在本机收到的消息等价，请照常推进工作。` +
      `如需回复这位用户，调用 onebot_send，target 用 private:${qq}；` +
      `不要在正文里解释这条说明，也不要复述本段。]\n\n` +
      text
    )
  }

  async function acquireAgent(sessionId) {
    const sid = SessionId(sessionId)
    let handle = null
    try {
      handle = agents.get(sid)
    } catch (err) {
      log(`[agent] get 抛错: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!handle) {
      log(`[agent] resume ${sessionId}`)
      // 与 restart.js 同理：resume 不带 agentOptions 时，被恢复 agent 的 provider/model 是空的，
      // 提示词里的 {{model}} 在组装阶段取不到值，这一轮直接报错；而且这个空 options 的 agent
      // 会留在进程里，之后在 GUI 里给同一会话发消息也照样报错，看起来就是"卡死"。
      // 所以一定要用界面当前选中的模型去 resume。
      const agentOptions = await resolveResumeAgentOptions({ ctx, agents }, log)
      if (!agentOptions) {
        log(`[agent] 拿不到模型选择，拒绝 resume ${sessionId}`)
        throw new Error('拿不到可用的模型选择，无法恢复这个会话（先在 DSH 里选好模型再试）')
      }
      log(`[agent] resume 使用的模型：${agentOptions.provider}/${agentOptions.model}`)
      // 与 GUI 恢复会话保持一致：把默认预设也挂回去，否则被恢复的 agent 只有裸工具集，
      // 预设贡献的系统提示段和工具都缺席。拿不到预设服务时退化成只带模型。
      const preset = await composePresetSetup()
      // 新版 AgentLoop 的 resume 读的是 options.resumeSessionId；
      // 传 sessionId 会让内部按 undefined 取长度而抛 "Cannot read properties of undefined (reading 'length')"。
      // 两个键都传，兼容新旧版本。
      handle = await agents.resume({
        resumeSessionId: sid,
        sessionId: sid,
        agentOptions,
        ...(preset ? { setup: preset.setup } : {}),
      })
    }
    return handle
  }

  async function inject(qq, sessionId, text) {
    const handle = await acquireAgent(sessionId)
    const agent = handle?.agent ?? handle
    if (!agent || typeof agent.followup !== 'function') {
      throw new Error(`拿到的句柄没有 followup 方法（session ${sessionId}）`)
    }
    pendingTurns.set(qq, (pendingTurns.get(qq) ?? 0) + 1)
    sentThisTurn.delete(qq)
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: buildHint(qq, text) }],
        source: { kind: 'user' },
      }),
    )
    log(`[inject] ${qq} -> ${sessionId}: ${text.slice(0, 120)}`)

    // 后台等这一轮跑完：落盘 + 必要时提示“没有回话”。
    void (async () => {
      try {
        if (typeof agent.whenIdle === 'function') await agent.whenIdle()
        if (sessions && typeof sessions.flush === 'function' && agent.session) {
          await sessions.flush(agent.session)
        }
        const left = (pendingTurns.get(qq) ?? 1) - 1
        if (left <= 0) {
          pendingTurns.delete(qq)
          if (config.silence_notice && !sentThisTurn.has(qq)) {
            // 模型这一轮没主动调 onebot_send：先把该会话最新的一条助手回复回给用户。
            // 但如果这一轮是报错结束的，会话里没有新助手消息，回旧回复会让人以为取错了会话，
            // 所以改为把错误原文报回去。
            const err = lastTurnError(agent)
            const latest = readLatest(agent)
            const body = latest.lastAssistant || latest.last
            if (err) {
              await sendText(qq, `【${shortId(sessionId)}】这一轮报错：${err}`)
              log(`[turn] ${shortId(sessionId)} 报错结束：${err}`)
            } else if (body) {
              await sendText(qq, `【${shortId(sessionId)}】${body}`)
            } else {
              await sendText(qq, `（${prefix}${shortId(sessionId)} 这一轮结束，模型未调用 onebot_send，也没读到会话正文。诊断：${latest.shape}）`)
              log(`[latest] 读不到正文: ${latest.shape}`)
            }
          }
          sentThisTurn.delete(qq)
        } else {
          pendingTurns.set(qq, left)
        }
      } catch (err) {
        log(`[turn] 等待结束出错: ${err instanceof Error ? err.message : String(err)}`)
      }
    })()
  }

  /** 取会话最新消息回给用户。which = 'msg'（最新助手回复）| 'last'（最后一条消息，不分角色）。 */
  async function pullLatest(qq, which, routeToken) {
    const target = routeToken ? await resolveRoute(routeToken) : sticky.get(qq) ?? config.default_session
    if (!target) {
      await sendText(qq, `用法：${prefix}msg <路由> 或 ${prefix}<路由> msg（先发 ${prefix}list 看编号）`)
      return
    }
    const resolved = (await resolveRoute(target).catch(() => null)) ?? target
    try {
      const handle = await acquireAgent(resolved)
      const latest = readLatest(handle?.agent ?? handle)
      // msg = 最新助手回复；last = 该会话里用户自己发的最后一条
      const text = which === 'msg' ? latest.lastAssistant || latest.last : latest.lastUser
      if (text) {
        await sendText(qq, `【${shortId(resolved)}】${text}`)
      } else {
        await sendText(
          qq,
          which === 'msg'
            ? `这个会话还没有助手回复（${latest.shape}）`
            : `这个会话里没有你发过的消息（${latest.shape}）`,
        )
        log(`[latest] ${resolved} ${which} ${latest.shape}`)
      }
    } catch (err) {
      await sendText(qq, `读取失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── 入站 ──────────────────────────────────────────────────────────────────
  /**
   * 与 GUI 建会话一致地建一个新会话：一定要带模型选择、工作目录、预设挂载。
   *
   * 少带 agentOptions 的后果就是本插件之前的 bug：新建会话的 provider/model 为空，
   * 第一轮组装提示词时 {{model}} 取不到值，整轮直接报错，用户看到的就是"收不到回复"。
   * 没有 cwd 则会话不落在任何工作区，文件类工具的沙箱没有基准目录；没有 setup
   * 则默认预设（工具集与系统提示）不会挂到这个 agent 上。
   */
  async function createSessionForQq() {
    const agentOptions = await resolveResumeAgentOptions({ ctx, agents }, log)
    if (!agentOptions) {
      throw new Error('拿不到可用的模型选择，无法新建会话（先在 DSH 界面里选好模型再试）')
    }
    const cwd = String(config.workspace ?? '').trim() || knownCwd || (await scanRecentCwd())
    const preset = await composePresetSetup()
    const sid = `session-${randomUUID()}`
    log(
      `[new] 模型 ${agentOptions.provider}/${agentOptions.model}，cwd=${cwd || '(未指定)'}` +
        (preset ? `，预设 ${preset.agentPreset}` : '，无预设'),
    )
    await agents.create({
      sessionId: SessionId(sid),
      agentOptions,
      ...(cwd || preset
        ? { meta: { ...(cwd ? { cwd } : {}), ...(preset ? { agentPreset: preset.agentPreset } : {}) } }
        : {}),
      ...(preset ? { setup: preset.setup } : {}),
    })
    return sid
  }

  /** 还没有任何 #list 之前，直接扫最近的几个会话头，拿一个 cwd 当默认工作目录。 */
  async function scanRecentCwd() {
    try {
      const items = await listSessions(5)
      knownCwd = items.find((x) => x.cwd)?.cwd ?? knownCwd
    } catch {
      /* 读不到就不写 cwd */
    }
    return knownCwd
  }

  /**
   * 解析默认 Agent 预设，并给出发布前挂载它的 setup 回调（与 GUI 的 composeAgent 同形）。
   * agentPresets 服务不存在时返回 undefined，调用方退化成不带预设。
   */
  async function composePresetSetup() {
    const presets = ctx.get('agentPresets')
    if (!presets || typeof presets.resolve !== 'function' || typeof presets.mount !== 'function') return undefined
    try {
      const resolved = await presets.resolve(undefined)
      return {
        agentPreset: resolved.id,
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, resolved.id)
        },
      }
    } catch (err) {
      log(`[new] 预设解析失败，按无预设继续：${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  /** 新建一个空会话，并把它设成该 QQ 的默认路由。 */
  async function newSession(qq) {
    const sid = await createSessionForQq()
    await refreshTable()
    sticky.set(qq, sid)
    persistSticky()
    const idx = [...table.byIndex.entries()].find(([, v]) => v === sid)?.[0] ?? '?'
    log(`[new] ${qq} -> ${sid}（编号 ${idx}）`)
    return { sid, idx }
  }

  const CHECK_PROMPT = [
    '这是通过 QQ 触发的一次自检。请检查本机 dsh-qq-router 插件是否正常工作，最后用 onebot_send 把结论发回 QQ。',
    '要查的东西：',
    '1) 插件日志 ~/.dsh/dsh-qq-router.log 最近 50 行，有没有 "处理失败" 或其它报错。',
    '2) 唤醒器日志 ~/.dsh/dsh-waker.log 最近 20 行，以及 ~/.dsh/qq-router-heartbeat 是否存在、多少秒前更新。',
    '3) NapCat 的 OneBot 端口 3001 是否在听（用 pwsh 查 Get-NetTCPConnection -LocalPort 3001）。',
    '4) 配置一致性：~/.dsh/profiles/desktop/cordis.patch.yml 里 dsh-qq-router 的键，与 lib/index.js 里 Config schema 的键是否完全一致。',
    '5) 结论用一句话说清：正常 / 哪一环坏了 / 建议怎么修。回复简短，不要贴大段日志。',
  ].join('\n')

  async function startNewSession(qq, note) {
    try {
      const { sid, idx } = await newSession(qq)
      await sendText(qq, `已新建对话 ${shortId(sid)}（编号 ${idx}），已设为你的默认路由。\n直接发内容就行。`)
      if (note && note.trim()) await inject(qq, sid, note.trim())
    } catch (err) {
      await sendText(qq, `新建对话失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function runCheck(qq, extra) {
    try {
      const { sid, idx } = await newSession(qq)
      await sendText(qq, `已开新对话 ${shortId(sid)}（编号 ${idx}）做排查，结果会发回 QQ。`)
      const text = extra && extra.trim() ? `${CHECK_PROMPT}\n\n额外要求：${extra.trim()}` : CHECK_PROMPT
      await inject(qq, sid, text)
    } catch (err) {
      await sendText(qq, `自检失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 重启 DSH：真正的动作由计划任务在进程树之外执行，见 restart.js。 */
  async function restartViaTask(qq, rest) {
    if (typeof hooks.restart !== 'function') {
      await sendText(qq, '重启能力没接上：装的是拆分版插件，没有 restart 那一半。')
      return
    }
    const secs = Number(rest) || 15
    try {
      const r = await hooks.restart(secs, `来自 QQ 的 ${prefix}restart`)
      await sendText(
        qq,
        `已排程：${r.delaySecs} 秒后重启 DSH（${r.scheduledAt}）。\n` +
          '窗口会关掉再自己弹回来，NapCat 会跟着重连；' +
          `20～40 秒后发 ${prefix}start 确认。`,
      )
    } catch (err) {
      await sendText(qq, `重启排程失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── 停止会话 ──────────────────────────────────────────────────────────────
  // 和客户端那个停止按钮做同一件事：agent.cancel({ kind: 'user' }) —— 中断当前这一轮，
  // 顺带把排队等着的消息（inbox）一起清掉。中止逻辑归 DSH 管，这里不自己拼。
  /** agent.status 是 idle/running 的字符串 getter；拿不到时退回 phase.kind。 */
  function isRunningAgent(agent) {
    if (!agent) return false
    if (typeof agent.status === 'string') return agent.status === 'running'
    const phase = agent.phase
    const kind = typeof phase === 'string' ? phase : phase?.kind
    return !/^(idle|maintenance)$/.test(String(kind ?? ''))
  }

  /** 内存里活着的 agent 列表：[{ agent, sid, running }]。 */
  function liveSessions() {
    const handles = typeof agents.list === 'function' ? agents.list() : []
    const out = []
    for (const handle of handles) {
      const agent = handle?.agent ?? handle
      const sid = String(agent?.session?.header?.id ?? agent?.id ?? '')
      if (!sid) {
        log(`[live] 取不到会话 id: agent=[${Object.keys(agent ?? {}).join(',')}]`)
        continue
      }
      out.push({ agent, sid, running: isRunningAgent(agent) })
    }
    return out
  }

  /** #stop：停掉指定会话（不写路由时用默认路由；只有一个在跑就直接停它）。 */
  async function stopSession(qq, rest) {
    const running = liveSessions().filter((item) => item.running)
    if (!running.length) {
      await sendText(qq, `现在没有正在输出的会话，没得停（${prefix}running 可以确认）。`)
      return
    }

    const token = String(rest ?? '').trim().split(/\s+/)[0] ?? ''
    let target = ''
    if (token) {
      const resolved = await resolveRoute(token)
      if (!resolved) {
        await sendText(qq, `没找到路由「${token}」。先发 ${prefix}list 看看。`)
        return
      }
      target = resolved
    } else {
      const current = sticky.get(qq) ?? config.default_session ?? ''
      if (current) target = (await resolveRoute(current).catch(() => null)) ?? current
    }

    let hit = target ? running.find((item) => item.sid === target) : null
    if (!hit && !target) {
      if (running.length === 1) {
        hit = running[0]
      } else {
        const rows = []
        for (const item of running) {
          const title = await readTitle(item.sid)
          rows.push(`${shortId(item.sid)}  ${title || '(无标题)'}`)
        }
        await sendText(
          qq,
          [`有 ${running.length} 个会话正在跑，得指定停哪个：`, ...rows, '', `用法：${prefix}stop <路由>`].join('\n'),
        )
        return
      }
    }
    if (!hit) {
      if (target) {
        const title = await readTitle(target)
        await sendText(qq, `${shortId(target)}${title ? ' 「' + title + '」' : ''} 现在没在跑，不用停。`)
      }
      return
    }

    const { agent, sid } = hit
    const title = await readTitle(sid)
    try {
      if (typeof agent.cancel === 'function') agent.cancel({ kind: 'user' })
      else if (typeof agent.abort === 'function') await agent.abort()
      else throw new Error('这个 agent 没有 cancel/abort 方法')
      log(`[stop] 已请求停止 ${sid}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`[stop] 停止失败: ${message}`)
      await sendText(qq, `停止失败：${message}`)
      return
    }

    // 中止是异步收敛的：最多等 3 秒看它有没有真的落到 idle，再据实回报。
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && isRunningAgent(agent)) await delay(200)
    await sendText(
      qq,
      `已停 ${shortId(sid)}${title ? ' 「' + title + '」' : ''}${isRunningAgent(agent) ? '（还没完全停下，稍等再看一眼）' : ''}\n` +
        '和客户端停止按钮一样：这一轮立刻中断，排队的消息也一起清掉。',
    )
  }

  // ── 本轮提权 ──────────────────────────────────────────────────────────────
  // #escalate 把本轮内「需要授权的操作」全部自动放行（等价于替人一路点允许），
  // 回合结束（agent 从 running 回到 idle）立刻撤销，权限回到原设定。
  // 命令词必须整词，不接受缩写；生效前要再发一次 #escalate confirm。

  function escalationRows() {
    const rows = []
    for (const [sid, item] of escalations) {
      rows.push(`${shortId(sid)}  已提权 ${Math.round((Date.now() - item.at) / 1000)}s`)
    }
    return rows
  }

  async function activateEscalation(qq, hit) {
    const { agent, sid } = hit
    const title = await readTitle(sid)
    escalations.set(sid, { agent, sid, at: Date.now(), qq })
    let released = 0
    for (const [code, entry] of [...approvals]) {
      if (entry.sid !== sid) continue
      if (settleApproval(code, 'allowed-once')) released += 1
    }
    log(`[escalate] 已提权 ${sid}${released ? `，顺带放行 ${released} 条待审批` : ''}`)
    await sendText(
      qq,
      [
        `已给 ${shortId(sid)}${title ? ' 「' + title + '」' : ''} 提权：本轮内需要授权的操作全部自动允许${released ? `（顺手放行了 ${released} 条挂着的审批）` : ''}。`,
        '只在当轮有效，这一轮跑完立刻恢复原权限。',
        `中途撤销：${prefix}escalate off`,
      ].join('\n'),
    )
    void watchEscalation(sid)
  }

  /** 盯着这一轮什么时候结束；结束就撤销提权。 */
  async function watchEscalation(sid) {
    const item = escalations.get(sid)
    if (!item) return
    const deadline = Date.now() + 2 * 60 * 60 * 1000
    while (escalations.has(sid) && !isRunningAgent(item.agent) && Date.now() < deadline) await delay(500)
    while (escalations.has(sid) && isRunningAgent(item.agent) && Date.now() < deadline) await delay(500)
    if (!escalations.has(sid)) return
    escalations.delete(sid)
    const title = await readTitle(sid)
    log(`[escalate] ${sid} 回合结束，权限已恢复`)
    for (const uid of allow) {
      await tellApproval(
        uid,
        `提权结束：${shortId(sid)}${title ? ' 「' + title + '」' : ''} 这一轮跑完了，权限回到原设定。`,
      )
    }
  }

  /** 挑一个会话作为提权目标；说不出是哪个就列出来让人选。 */
  async function pickEscalateTarget(qq, args) {
    const live = liveSessions()
    if (!live.length) {
      await sendText(qq, `现在没有活着的会话可以提权。先发 ${prefix}list 看看，或用 ${prefix}new 起一个。`)
      return null
    }
    const token = args.find((arg) => /\d|#/u.test(arg) || /^[A-Za-z_-]{2,}$/.test(arg)) ?? ''
    let target = ''
    if (token) {
      const resolved = await resolveRoute(token)
      if (!resolved) {
        await sendText(qq, `没找到路由「${token}」。先发 ${prefix}list 看看。`)
        return null
      }
      target = resolved
    } else {
      const current = sticky.get(qq) ?? config.default_session ?? ''
      if (current) target = (await resolveRoute(current).catch(() => null)) ?? current
    }
    if (target) {
      const hit = live.find((item) => item.sid === target)
      if (!hit) {
        await sendText(qq, `会话 ${shortId(target)} 现在没有活着（可能已关闭），没法提权。`)
        return null
      }
      return hit
    }
    const running = live.filter((item) => item.running)
    const pool = running.length ? running : live
    if (pool.length === 1) return pool[0]
    const rows = []
    for (const item of pool) {
      const title = await readTitle(item.sid)
      rows.push(`${shortId(item.sid)}  ${title || '(无标题)'}${item.running ? '  [在跑]' : ''}`)
    }
    await sendText(qq, ['有多个会话，得说清给哪个提权：', ...rows, '', `用法：${prefix}escalate <路由>`].join('\n'))
    return null
  }

  async function escalateFromQq(qq, rest) {
    const args = String(rest ?? '').trim().split(/\s+/).filter(Boolean)
    const first = String(args[0] ?? '').toLowerCase()

    if (['off', 'cancel', '撤销', '取消', '关闭'].includes(first)) {
      const route = args[1] ? ((await resolveRoute(args[1]).catch(() => null)) ?? '') : ''
      let cleared = 0
      for (const key of [...escalations.keys()]) {
        if (route && key !== route) continue
        escalations.delete(key)
        cleared += 1
      }
      escalatePending = null
      await sendText(qq, cleared ? `已撤销 ${cleared} 个会话的提权，权限回到原设定。` : '当前没有生效中的提权。')
      return
    }

    if (first === 'confirm') {
      const pending = escalatePending
      escalatePending = null
      if (!pending || pending.qq !== qq) {
        await sendText(qq, `没有等你确认的提权。先发 ${prefix}escalate [路由] 看范围，再发 ${prefix}escalate confirm。`)
        return
      }
      if (Date.now() - pending.at > 120000) {
        await sendText(qq, `确认超时了（超过 2 分钟），重新发 ${prefix}escalate 再来一次。`)
        return
      }
      await activateEscalation(qq, pending)
      return
    }

    if (escalations.size) {
      const rows = escalationRows()
      await sendText(qq, ['这些会话已经提权：', ...rows, '', `撤销：${prefix}escalate off`].join('\n'))
      return
    }

    const hit = await pickEscalateTarget(qq, args)
    if (!hit) return
    escalatePending = { qq, agent: hit.agent, sid: hit.sid, at: Date.now() }
    const title = await readTitle(hit.sid)
    await sendText(
      qq,
      [
        `要给 ${shortId(hit.sid)}${title ? ' 「' + title + '」' : ''} 提权吗？`,
        '作用：本轮内所有需要授权的操作自动允许（最高权限），这一轮结束立刻恢复原设定。',
        `确认请发：${prefix}escalate confirm（整词，不接受缩写，2 分钟内有效）`,
      ].join('\n'),
    )
  }

  async function handleMessage(event) {
    try {
      if (event?.post_type !== 'message') return
      if (event?.message_type !== 'private') return
      const qq = Number(event.user_id)
      if (!allow.has(qq)) {
        log(`[in] 忽略 ${qq}（不在白名单）`)
        return
      }
      const raw = messageToText(event.message ?? event.raw_message).trim()
      if (!raw) return
      if (!raw.startsWith(prefix)) {
        log(`[in] 忽略 ${qq}（没有前缀）: ${raw.slice(0, 60)}`)
        return
      }
      log(`[in] ${qq}: ${raw.slice(0, 160)}`)

      const body = raw.slice(prefix.length).trim()
      if (!body) return

      // 命令词只取第一行里的第一个词：带参数的单行命令（#1 msg、#set 2、#list 2、#restart 30）
      // 必须能拆成「命令 + 参数」。原来把整行当 head，这些指令全都拆不开，
      // #1 msg 会被当成正文 "1 msg" 注进默认会话。
      const firstLine = body.split(/\r?\n/, 1)[0]
      const head = firstLine.split(/\s+/)[0]
      const rest = body.slice(head.length).trim()

      if (['list', 'ls', '列表'].includes(head)) {
        await sendText(qq, await renderTable(Number(rest) || 1))
        return
      }
      if (['help', '?', '帮助'].includes(head)) {
        await sendText(qq, helpText())
        return
      }
      if (['status', '状态'].includes(head)) {
        const cur = sticky.get(qq) ?? config.default_session ?? ''
        await sendText(
          qq,
          [
            `OneBot: ${bot ? '已连接' : '未连接'} (${config.ws_url})`,
            `前缀: ${prefix}`,
            `当前默认路由: ${cur || '(未设定)'}`,
            `待回话轮次: ${pendingTurns.get(qq) ?? 0}`,
            `待回答提问: ${asks.size}，待审批: ${approvals.size}`,
            `提权中: ${escalations.size ? [...escalations.keys()].map((sid) => shortId(sid)).join('、') : '无'}`,
            `路由表: ${table.items.length} 条，${table.builtAt ? fmtTime(table.builtAt) + ' 建立' : '未建立'}`,
          ].join('\n'),
        )
        return
      }
      if (['set', 'use', '切换', '用', '设为'].includes(head)) {
        if (!rest) {
          await sendText(qq, `用法：${prefix}set <路由>（编号、别名或短 id），设完不带路由的消息都进它`)
          return
        }
        const target = await resolveRoute(rest)
        if (!target) {
          await sendText(qq, `没找到路由「${rest}」。先发 ${prefix}list 看看。`)
          return
        }
        sticky.set(qq, target)
        persistSticky()
        const title = await readTitle(target)
        await sendText(qq, `默认会话已设成 ${shortId(target)}${title ? ' 「' + title + '」' : ''}，重启 DSH 也还在。`)
        return
      }

      if (['ap', 'approvals', '审批', '待审批'].includes(head)) {
        if (!approvals.size) {
          await sendText(qq, '现在没有等你决定的审批。')
          return
        }
        const rows = [...approvals.entries()].map(([code, entry]) => `${code}  ${entry.label}`)
        await sendText(
          qq,
          ['等你决定的审批：', ...rows, '', `${prefix}y <编号> 允许，${prefix}n <编号> 拒绝`].join('\n'),
        )
        return
      }

      if (APPROVAL_YES.includes(head.toLowerCase()) || APPROVAL_NO.includes(head.toLowerCase())) {
        const allowIt = APPROVAL_YES.includes(head.toLowerCase())
        if (!approvals.size) {
          await sendText(qq, `现在没有等你决定的审批，${prefix}y / ${prefix}n 不用回。`)
          return
        }
        const code = rest || currentApprovalCode()
        if (!code) {
          await sendText(qq, `有 ${approvals.size} 条待审批，得带编号：${prefix}y <编号>，发 ${prefix}ap 看列表。`)
          return
        }
        if (!settleApproval(code, allowIt ? 'allowed-once' : 'rejected')) {
          await sendText(qq, `没有编号「${code}」的待审批。发 ${prefix}ap 看当前列表。`)
          return
        }
        return // settleApproval 那边已经挂了结果回报
      }

      if (['file', 'sendfile'].includes(head)) { await fileFromQq(qq, rest); return }

      if (['progress', '进度'].includes(head)) { await progressFromQq(qq, rest); return }

      if (['testask', '自检提问'].includes(head)) { await testAskOnce(qq); return }

      if (['answer', 'ans', 'a'].includes(head)) {
        await answerAskFromQq(qq, rest)
        return
      }

      if (['link', '配对', 'pin'].includes(head)) {
        try {
          const { url, ttl } = await fetchPairLink()
          await sendText(
            qq,
            [url, ttl !== null ? `（${ttl} 秒内有效，过期再发 ${prefix}link）` : `（本次运行有效；DSH 重启后失效，重发 ${prefix}link）`].filter(Boolean).join('\n'),
          )
        } catch (err) {
          await sendText(qq, `拿不到配对链接：${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }

      if (['new', '新建', '新对话'].includes(head)) {
        await startNewSession(qq, rest)
        return
      }

      if (['check', '排查', '自检'].includes(head)) {
        await runCheck(qq, rest)
        return
      }

      if (['start', '启动', '开机'].includes(head)) {
        const portUp = await portOpen(3001)
        if (bot && portUp) {
          await sendText(
            qq,
            [
              '运行中',
              `NapCat 已连上${lastSelfId ? '（bot ' + lastSelfId + '）' : ''}`,
              `插件在线，待回话 ${pendingTurns.get(qq) ?? 0} 轮`,
            ].join('\n'),
          )
          return
        }
        const wait = Number(config.start_wait_secs) || 90
        await sendText(
          qq,
          `没连上（端口 3001 ${portUp ? '在听，但握手失败' : '没在听'}），正在拉起 NapCat，最多等 ${wait} 秒`,
        )
        if (!portUp) {
          const spawned = spawnDetached(config.napcat_path)
          log(`[start] spawn "${config.napcat_path}" -> ${spawned ? 'ok' : 'fail'}`)
          if (!spawned) {
            await sendText(qq, `拉起 NapCat 失败，检查 napcat_path：${config.napcat_path}`)
            return
          }
        }
        const deadline = Date.now() + wait * 1000
        let connected = false
        let waited = 0
        while (Date.now() < deadline) {
          await delay(3000)
          waited += 3
          if (!(await portOpen(3001, 1000))) continue
          log(`[start] 端口已开，第 ${waited}s 尝试连接`)
          if (await startBot(1)) {
            connected = true
            break
          }
        }
        if (connected) {
          await sendText(qq, `NapCat 起来了${lastSelfId ? '，bot ' + lastSelfId + ' 已登录' : ''}，插件已连上`)
        } else {
          const stillUp = await portOpen(3001, 1000)
          await sendText(
            qq,
            stillUp
              ? `等了 ${wait} 秒端口在听但握手不进去 —— 多半是 bot 没登录，去 NapCat 那边扫码`
              : `等了 ${wait} 秒端口还是没开 —— NapCat 没启动成功，看它的日志`,
          )
        }
        return
      }

      if (['restart', '重启'].includes(head)) {
        await restartViaTask(qq, rest)
        return
      }

      if (['running', '运行中', '在跑'].includes(head)) {
        const handles = typeof agents.list === 'function' ? agents.list() : []
        const live = liveSessions()
        const lines = []
        for (const item of live) {
          if (!item.running) continue
          const title = await readTitle(item.sid)
          lines.push(`${shortId(item.sid)}  ${item.agent?.phase?.kind ?? 'running'}  ${title || '(无标题)'}`)
        }
        const pend = [...pendingTurns.entries()].filter(([, n]) => n > 0)
        await sendText(
          qq,
          (lines.length
            ? `正在运行 ${lines.length} 个：\n` + lines.join('\n') + `\n\n停止：${prefix}stop <路由>`
            : `没有正在运行的会话（内存里活着的 agent ${handles.length} 个，都不是运行态）`) +
            (pend.length ? `\n来自 QQ 的待回话轮次：${pend.map(([k, n]) => k + '×' + n).join('，')}` : ''),
        )
        return
      }

      if (['stop', '停止', '停'].includes(head)) {
        await stopSession(qq, rest)
        return
      }

      if (ESCALATE_WORDS.includes(head.toLowerCase())) {
        await escalateFromQq(qq, rest)
        return
      }

      if (['msg', 'last'].includes(head)) {
        await pullLatest(qq, head, rest)
        return
      }

      // 先试着把第一个词当路由；解析不出来就整段当作内容，用当前默认路由。
      let sessionId = null
      let text = body
      const token = body.split(/\s+/)[0]
      const candidate = await resolveRoute(token)

      // 打错命令或写错编号时只回用法：这类消息本意是操作插件，不该悄悄发给 AI。
      if (!candidate) {
        if (/^\d+$/.test(token)) {
          await sendText(qq, `没有 ${token} 号路由。先发 ${prefix}list 看编号，或用别名、短 id。`)
          return
        }
        // 只有整条就是一个纯 ASCII 词时才判为打错命令；中文内容、带空格的英文内容照旧当内容发。
        if (!rest && /^[A-Za-z][A-Za-z0-9_-]*$/.test(token)) {
          const near = nearestCommand(token)
          await sendText(
            qq,
            (near
              ? `没有「${token}」这个命令，你要发的是 ${prefix}${near} 吗？`
              : `没有「${token}」这个命令。`) + '\n\n' + helpText(),
          )
          return
        }
      }

      if (rest && candidate) {
        // 路由在前、命令在后也认：#<路由> msg / #<路由> last
        const sub = rest.split(/\s+/)[0]
        if (sub === 'msg' || sub === 'last') {
          await pullLatest(qq, sub, token)
          return
        }
        sessionId = candidate
        text = rest
      } else if (rest && !candidate) {
        // 首个词不是路由，整段就是内容（含多行）
        text = body
      }
      if (!sessionId) sessionId = sticky.get(qq) ?? (config.default_session || null)
      if (!sessionId) {
        await sendText(qq, `还没设定会话。先发 ${prefix}list 看编号，再用 ${prefix}use <编号> 固定，或直接写 ${prefix}<编号> 内容。`)
        return
      }
      const ok = await resolveRoute(sessionId).catch(() => null)
      if (!ok) {
        // 允许 default_session/sticky 里直接写 id
        log(`[route] 未能解析 ${sessionId}，按原值使用`)
      }
      await inject(qq, ok ?? sessionId, text)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`[in] 处理失败: ${message}`)
      try {
        if (bot) await sendText(Number(event?.user_id), `处理失败：${message}`)
      } catch {
        /* 连回复都失败就只能记日志 */
      }
    }
  }

  // ── 工具：让模型主动回话 ──────────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'onebot_send',
      description:
        '把一条消息发送到 QQ 用户。target 形如 private:<QQ>，必须在白名单内。这是内容送达 QQ 的唯一途径：每次调用立即发送，可以分多次调用（先回答、再查资料、再补充）。',
      parameters: {
        target: { type: 'string', required: true, description: '目标，例如 private:<QQ 号>' },
        content: { type: 'string', required: true, description: '要发送的文本' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            delivered: { type: 'boolean', required: true },
            target: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `已发送到 ${value.target}` }],
      },
      async execute(args) {
        const target = String(args.target ?? '')
        const content = String(args.content ?? '')
        const m = /^private:(\d+)$/.exec(target)
        if (!m) throw new Error('target 必须是 private:<QQ>')
        const uid = Number(m[1])
        if (!allow.has(uid)) throw new Error(`QQ ${uid} 不在白名单里`)
        if (!content.trim()) throw new Error('content 不能为空')
        await sendText(uid, content)
        pendingTurns.delete(uid)
        sentThisTurn.add(uid)
        return { delivered: true, target }
      },
    }),
  )

  // ── 工具：把文件/图片发到 QQ ──────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'onebot_send_file',
      description:
        '把本机文件或图片发到 QQ 用户。target 形如 private:<QQ>，必须在白名单内。用于把截图、报告、生成的文档直接送到 QQ；上限 100 MB。',
      parameters: {
        target: { type: 'string', required: true, description: '目标，例如 private:<QQ 号>' },
        path: { type: 'string', required: true, description: '本机文件的绝对路径' },
        caption: { type: 'string', description: '可选：文件前面附一句话' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            delivered: { type: 'boolean', required: true },
            target: { type: 'string', required: true },
            name: { type: 'string', required: true },
            bytes: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `已发送 ${value.name}（${value.bytes} 字节）到 ${value.target}` }],
      },
      async execute(args) {
        const target = String(args.target ?? '')
        const m = /^private:(\d+)$/.exec(target)
        if (!m) throw new Error('target 必须是 private:<QQ>')
        const uid = Number(m[1])
        if (!allow.has(uid)) throw new Error(`QQ ${uid} 不在白名单里`)
        const { name, size } = await sendFileTo(uid, String(args.path ?? ''), args.caption)
        pendingTurns.delete(uid)
        sentThisTurn.add(uid)
        return { delivered: true, target, name, bytes: size }
      },
    }),
  )

  // ── 工具：管理 DSH 之外的那一半（常驻唤醒器 + 登录自启）───────────────────
  // 插件跑在 DSH 里，DSH 关着时它不存在；所以"用 QQ 命令启动 DSH"必须由一个
  // 独立进程做。这里只负责安装、查询、卸载，不参与日常运行。
  const wakerPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'waker.mjs')

  // 桌面端宿主里 process.execPath 是 DeepSeek Harness.exe，不是 node，
  // 所以必须显式找 node 可执行文件来跑 waker.mjs。
  function resolveNodeExe() {
    const candidates = [
      process.env.DSH_NODE,
      join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
      'C:\Program Files\nodejs\node.exe',
    ].filter((value) => typeof value === 'string' && value.length > 0)
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return 'node'
  }
  const nodeExe = resolveNodeExe()

  function runPowerShell(lines) {
    return new Promise((resolve, reject) => {
      const dir = mkdtempSync(join(tmpdir(), 'qq-waker-'))
      const file = join(dir, 'run.ps1')
      writeFileSync(file, lines.join('\n'), 'utf8')
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
        { timeout: 180000, windowsHide: true },
        (err, stdout, stderr) => {
          try {
            rmSync(dir, { recursive: true, force: true })
          } catch {
            /* 忽略清理失败 */
          }
          const out = String(stdout || '').trim()
          if (err && !out) reject(new Error(String(stderr || err.message).trim()))
          else resolve(out || String(stderr || '').trim())
        },
      )
    })
  }

  function wakerPowerShell(action) {
    const dir = dirname(wakerPath)
    const cfgFile = join(dir, 'waker.config.json')
    const vbsFile = join(dir, 'waker-launch.vbs')
    const appExe = config.dsh_exe
    const appDir = dirname(appExe)
    const port = config.dsh_port
    const WSCRIPT = 'C:\\Windows\\System32\\wscript.exe'

    if (action === 'install') {
      const cfg = {
        ws: config.ws_url,
        allow: [...allow],
        prefix: config.prefix,
        exe: appExe,
        task: 'DSH Start',
        port,
        waitSecs: Math.max(90, Number(config.start_wait_secs) || 90),
      }
      const vbs = `CreateObject("WScript.Shell").Run """${nodeExe}"" ""${wakerPath}""", 0, False`
      return [
        "$ErrorActionPreference = 'Stop'",
        `Set-Content -Path '${cfgFile}' -Encoding ASCII -Value '${JSON.stringify(cfg)}'`,
        `Set-Content -Path '${vbsFile}' -Encoding ASCII -Value '${vbs.replace(/'/g, "''")}'`,
        "$pr = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive",
        `$actW = New-ScheduledTaskAction -Execute '${WSCRIPT}' -Argument '"${vbsFile}"'`,
        '$setW = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)',
        '$trg = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
        "Register-ScheduledTask -TaskName 'DSH Waker' -Action $actW -Trigger $trg -Settings $setW -Principal $pr -Force | Out-Null",
        `$actS = New-ScheduledTaskAction -Execute '${appExe}' -WorkingDirectory '${appDir}'`,
        '$setS = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances Parallel',
        "Register-ScheduledTask -TaskName 'DSH Start' -Action $actS -Settings $setS -Principal $pr -Force | Out-Null",
        '$startup = [Environment]::GetFolderPath("Startup")',
        '$lnk = Join-Path $startup "DeepSeek Harness.lnk"',
        '$sh = New-Object -ComObject WScript.Shell',
        '$s = $sh.CreateShortcut($lnk)',
        `$s.TargetPath = '${appExe}'`,
        `$s.WorkingDirectory = '${appDir}'`,
        '$s.Save()',
        "Stop-ScheduledTask -TaskName 'DSH Waker' -ErrorAction SilentlyContinue",
        "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*waker.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
        'Start-Sleep -Seconds 1',
        "Start-ScheduledTask -TaskName 'DSH Waker'",
        'Start-Sleep -Seconds 4',
        "'OK installed'",
      ]
    }

    if (action === 'status') {
      return [
        '$lines = @()',
        "foreach ($n in @('DSH Start','DSH Waker')) {",
        '  $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue',
        '  $i = Get-ScheduledTaskInfo -TaskName $n -ErrorAction SilentlyContinue',
        "  $state = if ($t) { $t.State } else { 'missing' }",
        "  $res = if ($i) { $i.LastTaskResult } else { '-' }",
        "  $when = if ($i) { $i.LastRunTime.ToString('MM-dd HH:mm') } else { '-' }",
        '  $lines += ($n + "|" + $state + "|" + $res + "|" + $when)',
        '}',
        '$lnk = Join-Path ([Environment]::GetFolderPath("Startup")) "DeepSeek Harness.lnk"',
        'if (Test-Path $lnk) { $lines += "autostart|yes" } else { $lines += "autostart|no" }',
        'try { $lines += ("procs|" + ((Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Measure-Object).Count)) } catch { $lines += "procs|?" }',
        '$lines -join "`n"',
      ]
    }

    if (action === 'uninstall') {
      return [
        "Unregister-ScheduledTask -TaskName 'DSH Waker' -Confirm:$false -ErrorAction SilentlyContinue",
        "Unregister-ScheduledTask -TaskName 'DSH Start' -Confirm:$false -ErrorAction SilentlyContinue",
        '$lnk = Join-Path ([Environment]::GetFolderPath("Startup")) "DeepSeek Harness.lnk"',
        'if (Test-Path $lnk) { Remove-Item $lnk -Force }',
        `if (Test-Path '${vbsFile}') { Remove-Item '${vbsFile}' -Force }`,
        "'OK uninstalled'",
      ]
    }

    if (action === 'start') return ["Start-ScheduledTask -TaskName 'DSH Waker'", "'OK started'"]
    if (action === 'stop') {
      return ["Stop-ScheduledTask -TaskName 'DSH Waker' -ErrorAction SilentlyContinue", "'OK stopped'"]
    }
    return null
  }

  ctx.tools.register(
    defineTool({
      name: 'qq_waker',
      description:
        '管理 QQ 远程唤醒链路里 DSH 之外的那一半：常驻唤醒器（DSH 关着时收到 #start 就启动 DSH）与登录自启。action: install 安装并启动、status 查询状态、start/stop 启停唤醒器、uninstall 卸载。安装是幂等的，可重复执行。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: 'install | status | start | stop | uninstall',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            detail: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.detail }],
      },
      async execute(args) {
        const action = String(args.action ?? 'status')
        const lines = wakerPowerShell(action)
        if (!lines) throw new Error(`未知 action: ${action}（可用 install / status / start / stop / uninstall）`)
        const raw = await runPowerShell(lines)
        if (action === 'status') {
          const stateMap = { Ready: '就绪', Running: '正在运行', Disabled: '已禁用', missing: '不存在' }
          const out = raw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const p = line.split('|')
              if (p[0] === 'autostart') return `登录自启: ${p[1] === 'yes' ? '已设置' : '未设置'}`
              if (p[0] === 'procs') return `DSH 进程: ${p[1] === '0' ? '没在跑' : `${p[1]} 个`}`
              return `${p[0]}: ${stateMap[p[1]] ?? p[1]}｜上次结果 ${p[2]}｜上次运行 ${p[3]}`
            })
          return { ok: true, detail: out.join('\n') || '（无输出）' }
        }
        const done = {
          install: '已安装：DSH Waker（登录自启、常驻）、DSH Start（启动任务）、登录自启快捷方式；唤醒器已启动',
          uninstall: '已卸载：两个计划任务、登录自启快捷方式、隐藏启动脚本（waker.config.json 保留）',
          start: '唤醒器已启动',
          stop: '唤醒器已停止',
        }
        return { ok: true, detail: done[action] ?? (raw || '完成') }
      },
    }),
  )

  // ── 连接 ──────────────────────────────────────────────────────────────────
  const clientLog = {
    info: (m) => log(`[onebot info] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
    warn: (m) => log(`[onebot warn] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
    error: (m) => log(`[onebot error] ${typeof m === 'string' ? m : JSON.stringify(m)}`),
  }

  let lastSelfId = ''
  let pairLinkSent = false
  let heartbeatTimer = null

  /** 等 webServer 注入完成并返回端口。 */
  async function waitWebPort() {
    for (let i = 0; i < 15 && !webServerRef; i++) await delay(200)
    const port = webServerRef && typeof webServerRef.port === 'number' ? webServerRef.port : 0
    if (!port) throw new Error('拿不到 web 服务端口（webserver 未就绪）')
    return port
  }

  /** DSH Web 自己对内广告的地址（loopback）。 */
  function advertisedUrl() {
    try {
      const webApp = ctx.get('webApp')
      const url = webApp && typeof webApp.getAdvertisedUrl === 'function' ? webApp.getAdvertisedUrl() : ''
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url
    } catch {
      /* 没有 webApp 服务就退回 loopback */
    }
    return `http://127.0.0.1:${webServerRef?.port ?? 0}/`
  }

  /**
   * 默认出口地址：向公网地址 connect 一个 UDP socket，读它绑定的本机地址（不发包）。
   * 这样拿到的是真正能上网那块网卡（通常是 WLAN），而不是虚拟网卡。
   */
  async function defaultRouteAddress() {
    const socket = createUdpSocket('udp4')
    try {
      await new Promise((resolve, reject) => {
        socket.once('error', reject)
        socket.connect(53, '223.5.5.5', () => resolve())
      })
      const addr = socket.address()
      return typeof addr?.address === 'string' && addr.address !== '0.0.0.0' ? addr.address : ''
    } catch {
      return ''
    } finally {
      try {
        socket.close()
      } catch {
        /* 已关闭 */
      }
    }
  }

  /** 挑一个手机能访问的本机 IPv4：默认出口地址优先，其次常见局域网段，最后任意地址。 */
  async function pickLanAddress() {
    const routed = await defaultRouteAddress()
    if (routed) return routed
    const list = []
    for (const entries of Object.values(networkInterfaces())) {
      for (const a of entries ?? []) {
        if (!a || a.family !== 'IPv4' || a.internal) continue
        list.push(a.address)
      }
    }
    const score = (ip) => {
      if (/^192\.168\./.test(ip)) return 0
      if (/^10\./.test(ip)) return 1
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return 3
      return 4
    }
    list.sort((a, b) => score(a) - score(b))
    return list[0] ?? ''
  }

  /**
   * 把一条进来的连接转发给 DSH Web，并把 Host / Origin 改写成 loopback 权威。
   *
   * 为什么必须改写：Web 服务的 Host/Origin 围栏只认它自己监听的权威，鉴权 cookie 也按
   * 权威命名与校验。手机用局域网地址访问时，只有改写后整条鉴权链才和本机浏览器一致。
   * 非升级请求补 Connection: close，保证一条连接只承载一个请求，不会漏改后续请求的 Host。
   */
  function proxyConnection(socket, upstreamPort) {
    const authority = `127.0.0.1:${upstreamPort}`
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buf.length > 128 * 1024) socket.destroy()
        return
      }
      socket.removeListener('data', onData)
      const lines = buf.subarray(0, end).toString('latin1').split('\r\n')
      const rest = buf.subarray(end + 4)
      const isUpgrade = lines.some((l) => /^upgrade:/i.test(l))
      const out = [lines[0]]
      for (const line of lines.slice(1)) {
        if (/^host:/i.test(line)) out.push(`Host: ${authority}`)
        else if (/^origin:/i.test(line)) out.push(`Origin: http://${authority}`)
        else if (/^referer:/i.test(line)) out.push(line.replace(/^([a-z]+:\/\/)[^/]+/i, `$1${authority}`))
        else if (!isUpgrade && /^connection:/i.test(line)) continue
        else out.push(line)
      }
      if (isUpgrade) socket.setTimeout(0)
      else out.push('Connection: close')
      const upstream = createConnection({ host: '127.0.0.1', port: upstreamPort })
      upstream.on('connect', () => {
        upstream.write(Buffer.from(out.join('\r\n') + '\r\n\r\n', 'latin1'))
        if (rest.length) upstream.write(rest)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      upstream.on('error', () => socket.destroy())
      upstream.on('close', () => socket.destroy())
      socket.on('close', () => upstream.destroy())
    }
    socket.on('error', () => socket.destroy())
    socket.setTimeout(60000, () => socket.destroy())
    socket.on('data', onData)
  }

  let linkProxy = null
  let linkProxyStarting = null

  /** 起动（或复用）本机代理端口，返回 { port, upstreamPort }。 */
  async function ensureLinkProxy() {
    if (linkProxy) return linkProxy
    if (linkProxyStarting) return linkProxyStarting
    linkProxyStarting = (async () => {
      const upstreamPort = await waitWebPort()
      const port = Number(config.link_proxy_port) || 62566
      const server = createNetServer((socket) => proxyConnection(socket, upstreamPort))
      server.on('error', (err) => log(`[link] 代理出错: ${err instanceof Error ? err.message : String(err)}`))
      await new Promise((resolve, reject) => {
        const onError = (err) => reject(err)
        server.once('error', onError)
        server.listen(port, '0.0.0.0', () => {
          server.removeListener('error', onError)
          resolve()
        })
      })
      linkProxy = { server, port, upstreamPort }
      log(`[link] 本机代理 0.0.0.0:${port} -> 127.0.0.1:${upstreamPort}`)
      return linkProxy
    })()
    try {
      return await linkProxyStarting
    } finally {
      linkProxyStarting = null
    }
  }

  /** 本机代理 + 本次运行的启动令牌，拼出一条手机能直接打开的链接。 */
  async function localLink() {
    const proxy = await ensureLinkProxy()
    const raw = String(config.link_public_host ?? '').trim()
    let base
    if (/^https?:\/\//i.test(raw)) {
      base = raw.endsWith('/') ? raw : `${raw}/`
    } else {
      const host = raw || (await pickLanAddress())
      if (!host) throw new Error('找不到可用的局域网地址')
      const authority = host.includes(':') ? host : `${host}:${proxy.port}`
      base = `http://${authority}/`
    }
    let connection = null
    try {
      connection = ctx.get('connection')
    } catch {
      connection = null
    }
    const url =
      connection && typeof connection.authenticatedUrl === 'function' ? connection.authenticatedUrl(base) : base
    log(`[link] ${base} token=${connection && typeof connection.authenticatedUrl === 'function' ? 'yes' : 'no'}`)
    return { url, ttl: null, publicBase: new URL(base).host }
  }

  /**
   * 取一条远程链接：装了远程访问插件（cloudflare 隧道）就优先用它的公网链接，
   * 没装就退回本机代理链接（局域网地址 + 本机代理端口 + 本次运行的启动令牌）。
   */
  async function fetchPairLink() {
    try {
      const port = await waitWebPort()
      const body = config.pair_link_address ? JSON.stringify({ address: config.pair_link_address }) : '{}'
      const res = await fetch(`http://127.0.0.1:${port}/api/pair/issue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data && data.ok === true && typeof data.url === 'string') {
        const ttl =
          typeof data.expiresAt === 'number' ? Math.max(0, Math.round((data.expiresAt - Date.now()) / 1000)) : null
        return { url: data.url, ttl, publicBase: data.publicBaseUrl }
      }
      log(`[pair] 远程访问插件没有配对接口（${res.status}），改用本机代理链接`)
    } catch (err) {
      log(`[pair] 远程访问插件不可用（${err instanceof Error ? err.message : String(err)}），改用本机代理链接`)
    }
    return localLink()
  }

  /** 探测本机端口是否可连（用来判断 NapCat 的 WS 是否在听）。 */
  function portOpen(port, timeout = 1200) {
    return new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      let settled = false
      const done = (ok) => {
        if (settled) return
        settled = true
        try { socket.destroy() } catch { /* 忽略 */ }
        resolve(ok)
      }
      socket.setTimeout(timeout)
      socket.once('connect', () => done(true))
      socket.once('timeout', () => done(false))
      socket.once('error', () => done(false))
    })
  }

  /** 脱离父进程启动一个可执行文件（NapCat 桌面端）。 */
  function spawnDetached(exePath) {
    try {
      const child = spawn(exePath, [], { detached: true, stdio: 'ignore' })
      child.on('error', (err) => log(`[start] spawn 出错: ${err.message}`))
      child.unref()
      return true
    } catch (err) {
      log(`[start] spawn 抛错: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /** 连一次 OneBot；成功则绑定消息处理与 self_id 记录。 */
  async function startBot(attempts = 20) {
    if (bot) return true
    try {
      bot = await connect({
        baseUrl: config.ws_url,
        accessToken: config.access_token,
        log: clientLog,
        reconnection: { enable: true, attempts, delay: 5000 },
      })
    } catch (err) {
      bot = null
      log(`[connect] 失败: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
    const remember = (event) => {
      const self = event?.self_id
      if (self) lastSelfId = String(self)
    }
    bot.on('message', (event) => {
      remember(event)
      void handleMessage(event)
    })
    if (typeof bot.on === 'function') {
      try { bot.on('meta_event', remember) } catch { /* 该实现可能只有 message */ }
    }
    log('[connect] ok, message handler bound')

    // 心跳：唤醒器靠它判断"插件还在不在"。
    // 只看进程数会误判 —— DSH 关掉后残留进程仍然存在，唤醒器会以为插件在，
    // 于是保持沉默，而实际没人回答，命令就石沉大海。
    const heartbeatPath = join(dshHome, 'qq-router-heartbeat')
    const beat = () => {
      try {
        writeFileSync(heartbeatPath, String(Date.now()), 'utf8')
      } catch {
        /* 心跳失败不致命 */
      }
    }
    beat()
    heartbeatTimer = setInterval(beat, 30000)
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()

    // 自动分享配对链接：DSH 每次重启后原来的链接就失效了，
    // 连上 QQ 时顺手发一条新的，手机上直接点开就能进。
    if (config.pair_link_autosend && !pairLinkSent) {
      pairLinkSent = true
      void (async () => {
        try {
          const { url, ttl } = await fetchPairLink()
          for (const uid of allow) {
            try {
              await sendText(uid, [url, ttl !== null ? `（${ttl} 秒内有效）` : ''].filter(Boolean).join('\n'))
            } catch {
              /* 某个白名单用户发不出去不影响其他 */
            }
          }
          log('[pair] 已自动发送配对链接')
        } catch (err) {
          log(`[pair] 自动发送失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      })()
    }
    return true
  }

  void startBot(20)

  // progress_secs > 0 就自动开进度推送（也可以在 QQ 用 #progress 临时开）
  if (Number(config.progress_secs) > 0) {
    startProgress(Math.max(10, Math.min(3600, Math.round(Number(config.progress_secs)))))
  }

  // ── 看门狗：WS 断了或 NapCat 没开时自动拉起并重连 ──────────────────────────
  // 为什么必须有：NapCat 一关 WS 就断，QQ 消息到不了插件，任何命令都收不到。
  // 所以"救活"不能靠命令，只能靠插件自己定时探测。
  let reviving = false
  let lastSpawnAt = 0

  async function botAlive() {
    if (!bot) return false
    if (typeof bot.send !== 'function') return true
    try {
      await Promise.race([
        bot.send('get_status', {}),
        new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 4000)),
      ])
      return true
    } catch {
      log('[watchdog] 存活探测失败，判定 WS 已断')
      bot = null
      return false
    }
  }

  async function revive() {
    if (reviving) return
    reviving = true
    try {
      if (await botAlive()) return
      const portUp = await portOpen(3001)
      if (!portUp && Date.now() - lastSpawnAt > 5 * 60 * 1000) {
        lastSpawnAt = Date.now()
        const ok = spawnDetached(config.napcat_path)
        log(`[watchdog] 3001 没在听，拉起 NapCat -> ${ok ? 'ok' : 'fail'}`)
      }
      const wait = Number(config.start_wait_secs) || 90
      const deadline = Date.now() + wait * 1000
      while (Date.now() < deadline) {
        await delay(3000)
        if (!(await portOpen(3001, 1000))) continue
        if (await startBot(1)) {
          log('[watchdog] 已重连')
          for (const uid of allow) {
            try {
              await sendText(uid, `NapCat 断过，已自动拉起并重连${lastSelfId ? '（bot ' + lastSelfId + '）' : ''}`)
            } catch {
              /* 通知失败不影响重连 */
            }
          }
          return
        }
      }
      log('[watchdog] 本轮复活失败，下一轮再试')
    } finally {
      reviving = false
    }
  }

  const watchdogTimer = setInterval(() => { void revive() }, 45000)
  if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref()
  const reviveTimer = setTimeout(() => { void revive() }, 25000)
  if (typeof reviveTimer.unref === 'function') reviveTimer.unref()

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try {
        stopProgress()
        clearInterval(watchdogTimer)
        clearTimeout(reviveTimer)
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        try {
          rmSync(join(dshHome, 'qq-router-heartbeat'), { force: true })
        } catch {
          /* 删除失败不重要：mtime 过期后同样会被判为离线 */
        }
      } catch {
        /* 忽略 */
      }
      try {
        if (bot && typeof bot.disconnect === 'function') void bot.disconnect()
      } catch {
        /* 忽略卸载期错误 */
      }
      log('[dispose] disconnected')
    })
  }
}
