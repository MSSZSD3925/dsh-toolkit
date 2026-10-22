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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { appendFile, readFile, readdir, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { createZstdDecompress } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { connect } from 'onebot.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

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

  const headerCache = new Map() // sessionId -> { mtime, depth }

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

  /** 会话头里的 delegationDepth：0 = 主会话，>=1 = 子智能体；读不到返回 null。 */
  async function readDepth(sessionDir, sessionId, mtime) {
    const cached = headerCache.get(sessionId)
    if (cached && cached.mtime === mtime) return cached.depth
    let depth = null
    try {
      const buf = await readFile(join(sessionDir, 'session.v4.jsonl.zstd'))
      const line = await firstLineOfZstd(buf)
      const head = line ? JSON.parse(line) : null
      if (head && typeof head.delegationDepth === 'number') depth = head.delegationDepth
    } catch {
      depth = null
    }
    headerCache.set(sessionId, { mtime, depth })
    return depth
  }

  async function listSessions(limit) {
    const out = []
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
        const depth = await readDepth(sessionDir, session.name, mtime)
        // 子智能体（delegationDepth >= 1）不进路由表，避免把编号浪费在子会话上。
        // 读不到深度时按主会话处理，宁可多列也不漏。
        if (typeof depth === 'number' && depth > 0) continue
        out.push({
          id: session.name,
          project: project.name.replace(/^--|--$/g, ''),
          mtime,
          depth,
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
      `可用会话（共 ${all.length} 个，已排除子智能体；第 ${current}/${pages} 页）：`,
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
      `${prefix}list [页码]  列出会话与路由（已排除子智能体；编号会随活动变，别名和短 id 才稳）`,
      `${prefix}new        新建一个对话并设为默认路由`,
      `${prefix}check      新建对话做一次自检，结论发回 QQ`,
      `${prefix}restart [秒] 重启 DSH（默认 15 秒后），改完插件用它生效`,
      `${prefix}set <路由>   设定默认会话，重启 DSH 也不丢`,
      `${prefix}start      查两者状态；NapCat 没起来就拉起它并等登录`,
      `${prefix}link       取一个新的手机配对链接（600 秒有效）`,
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
    'list', 'new', 'check', 'set', 'use', 'link', 'pin',
    'start', 'running', 'msg', 'last', 'status', 'help', 'restart',
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
      // 新版 AgentLoop 的 resume 读的是 options.resumeSessionId；
      // 传 sessionId 会让内部按 undefined 取长度而抛 "Cannot read properties of undefined (reading 'length')"。
      // 两个键都传，兼容新旧版本。
      handle = await agents.resume({ resumeSessionId: sid, sessionId: sid })
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
            // 模型这一轮没主动调 onebot_send：把该会话最新的一条助手回复回给用户。
            const latest = readLatest(agent)
            const body = latest.lastAssistant || latest.last
            if (body) {
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
  /** 新建一个空会话，并把它设成该 QQ 的默认路由。 */
  async function newSession(qq) {
    const sid = `session-${randomUUID()}`
    await agents.create({ sessionId: SessionId(sid) })
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

      const head = body.split(/\r?\n/)[0]
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

      if (['link', '配对', 'pin'].includes(head)) {
        try {
          const { url, ttl } = await fetchPairLink()
          await sendText(
            qq,
            [url, ttl !== null ? `（${ttl} 秒内有效，过期再发 ${prefix}link）` : ''].filter(Boolean).join('\n'),
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
        const lines = []
        for (const h of handles) {
          const agent = h?.agent ?? h
          const sid = String(agent?.session?.header?.id ?? agent?.id ?? '')
          const phase = String(agent?.phase ?? '')
          if (!sid) {
            log(`[running] 取不到会话 id: agent=[${Object.keys(agent ?? {}).join(',')}] header=[${Object.keys(agent?.session?.header ?? {}).join(',')}]`)
            continue
          }
          if (/idle/i.test(phase)) continue
          const title = await readTitle(sid)
          lines.push(`${shortId(sid)}  ${phase || '(phase 为空)'}  ${title || '(无标题)'}`)
        }
        const pend = [...pendingTurns.entries()].filter(([, n]) => n > 0)
        await sendText(
          qq,
          (lines.length
            ? `正在运行 ${lines.length} 个：\n` + lines.join('\n')
            : `没有正在运行的会话（内存里活着的 agent ${handles.length} 个，都不是运行态）`) +
            (pend.length ? `\n来自 QQ 的待回话轮次：${pend.map(([k, n]) => k + '×' + n).join('，')}` : ''),
        )
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
        if (rest === 'msg' || rest === 'last') {
          await pullLatest(qq, rest, token)
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
        target: { type: 'string', required: true, description: '目标，例如 private:123456789' },
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

  /**
   * 向远程访问插件要一个新的配对链接。
   *
   * 那个插件把 /api/pair/issue 暴露在自己的 web 服务上，只接受【来自 loopback 的 POST】，
   * 我们和它在同一个宿主进程里，直接本机调用即可。返回的链接默认走它的 publicBaseUrl
   * （cloudflare 隧道域名），有效期 600 秒。
   */
  async function fetchPairLink() {
    for (let i = 0; i < 15 && !webServerRef; i++) await delay(200)
    const port = webServerRef && typeof webServerRef.port === 'number' ? webServerRef.port : 0
    if (!port) throw new Error('拿不到 web 服务端口（webserver 未就绪）')
    const body = config.pair_link_address ? JSON.stringify({ address: config.pair_link_address }) : '{}'
    const res = await fetch(`http://127.0.0.1:${port}/api/pair/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10000),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data || data.ok !== true || typeof data.url !== 'string') {
      throw new Error(`配对接口返回 ${res.status}`)
    }
    const ttl =
      typeof data.expiresAt === 'number' ? Math.max(0, Math.round((data.expiresAt - Date.now()) / 1000)) : null
    return { url: data.url, ttl, publicBase: data.publicBaseUrl }
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
