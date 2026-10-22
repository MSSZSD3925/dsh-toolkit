/**
 * dsh-pause —— 界面上的"暂停"按钮：点一下置位，循环在下一个步进边界停住等你。
 *
 * ════════════ 三个挂载点都是【只读解包 + 实机验证】得到的 ════════════
 *  1) 暂停点：dsh-agent-loop 的 `agent/pre-step` 瀑布钩子
 *       const decision = await this.dispatch.waterfall("agent/pre-step",
 *           { messages: claimed, ...position, signal }, () => Promise.resolve({ kind: "enter" }))
 *     监听器签名 async (payload, next) => …（同包样板 system-prompt/assemble 即此形状）。
 *  2) 路由注册：ctx.webServer.register 收的是【路由对象】：
 *       { kind: 'exact', path: '/xxx', handler: (req, res) => … }
 *     ★ 传裸函数会静默不注册任何路由（端点一直 404）—— 这是照 dsh-whale-widget
 *       的 registerRoute() 逐字核对出来的。
 *  3) 界面注入：桌面端【唯一】通道是 `webserver/index-inject` 的结构化行
 *     （tapIndex 在桌面端不生效：壳子的 index.html 从安装包静态读盘）。
 *     这一行必须在 apply() 里【第一时间】注册 —— 注入表由宿主启动时一次性收集。
 *     行类型用 kind:'script' 内联（不用 script-src：加载失败会 reject __DSH_BOOT_READY__），
 *     且由内联脚本自己建 <script src> 并吞掉 onerror，路由不在时静默失败。
 */
import z from '@deepseek-ai/schemastery'

const name = 'dsh-toolkit:pause'

const Config = z.object({
  routePrefix: z.string().default('/dsh-pause')
    .description('本插件注册的路由前缀'),
  waitSeconds: z.number().default(0)
    .description('没人管时多少秒后自动继续；0 表示一直等（默认）'),
})

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

/** 界面脚本：左下角一个"暂停"按钮 + 状态显示 + 一个"继续"按钮 */
const UI_JS = `
(function () {
  var PREFIX = '__PREFIX__'
  function el(id) { return document.getElementById(id) }
  function build() {
    if (el('dsh-pause-box')) return
    var box = document.createElement('div')
    box.id = 'dsh-pause-box'
    box.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483000;'
      + 'display:flex;gap:6px;align-items:center;font:12px/1.4 system-ui,sans-serif;'
      + 'background:rgba(20,20,24,.82);color:#eee;padding:6px 8px;border-radius:8px;'
      + 'box-shadow:0 2px 10px rgba(0,0,0,.35);user-select:none'
    var b = document.createElement('button')
    b.id = 'dsh-pause-btn'
    b.textContent = '暂停'
    b.title = '点一下：在下一个能停的地方停住，等你说完再继续'
    b.style.cssText = 'cursor:pointer;border:0;border-radius:6px;padding:4px 10px;'
      + 'background:#3b6ea5;color:#fff;font:inherit'
    var r = document.createElement('button')
    r.id = 'dsh-pause-resume'
    r.textContent = '继续'
    r.style.cssText = 'display:none;cursor:pointer;border:0;border-radius:6px;padding:4px 10px;'
      + 'background:#2f8f5b;color:#fff;font:inherit'
    var s = document.createElement('span')
    s.id = 'dsh-pause-state'
    s.style.cssText = 'opacity:.75'
    box.appendChild(b); box.appendChild(r); box.appendChild(s)
    ;(document.body || document.documentElement).appendChild(box)
    b.onclick = function () { post('/arm') }
    r.onclick = function () { post('/release') }
  }
  function post(path) {
    try {
      fetch(PREFIX + path, { method: 'POST' }).then(function (x) { return x.json() })
        .then(render).catch(function () {})
    } catch (e) {}
  }
  function render(st) {
    var s = el('dsh-pause-state'); var r = el('dsh-pause-resume'); var b = el('dsh-pause-btn')
    if (!s) return
    if (!st) { s.textContent = ''; return }
    if (st.holding) {
      s.textContent = '已停住，等你说话'
      r.style.display = ''; b.style.display = 'none'
      return
    }
    r.style.display = 'none'; b.style.display = ''
    if (!st.running) {
      // 空闲：没有任务在跑，暂停没有意义 —— 直接禁用
      s.textContent = '空闲中'
      b.disabled = true
      b.textContent = '暂停'
      b.style.background = '#555'
      b.style.cursor = 'default'
      b.style.opacity = '.55'
    } else if (st.armed) {
      s.textContent = '已请求暂停，等这一步到边界'
      b.disabled = false
      b.textContent = '取消'
      b.style.background = '#8a6d3b'
      b.style.cursor = 'pointer'
      b.style.opacity = '1'
    } else {
      s.textContent = ''
      b.disabled = false
      b.textContent = '暂停'
      b.style.background = '#3b6ea5'
      b.style.cursor = 'pointer'
      b.style.opacity = '1'
    }
  }
  function poll() {
    try {
      fetch(PREFIX + '/state').then(function (x) { return x.json() }).then(render).catch(function () {})
    } catch (e) {}
  }
  var KEY = 'dsh-pause-pos'
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
  function place(box, x, y) {
    var w = box.offsetWidth || 120, h = box.offsetHeight || 30
    box.style.left = clamp(x, 0, Math.max(0, innerWidth - w)) + 'px'
    box.style.top = clamp(y, 0, Math.max(0, innerHeight - h)) + 'px'
    box.style.bottom = 'auto'
  }
  function restore(box) {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null')
      if (s && typeof s.left === 'number' && typeof s.top === 'number') place(box, s.left, s.top)
    } catch (e) {}
  }
  function save(box) {
    try {
      var r = box.getBoundingClientRect()
      localStorage.setItem(KEY, JSON.stringify({ left: r.left, top: r.top }))
    } catch (e) {}
  }
  // 拖动：按住小条任意位置即可拖；移动少于 4 像素仍算点击，按钮照常能按
  function makeDraggable(box) {
    var sx = 0, sy = 0, ox = 0, oy = 0, down = false, moved = false
    box.style.cursor = 'grab'
    box.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return
      // 按在按钮上时【不启动拖动】：否则指针捕获会把 click 的目标改到小条上，
      // 按钮自己的 onclick 就再也不触发了（作者实测："拖动压过了点击"）。
      if (e.target && e.target.closest && e.target.closest('button')) return
      var r = box.getBoundingClientRect()
      down = true; moved = false
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top
      box.style.cursor = 'grabbing'
    })
    box.addEventListener('pointermove', function (e) {
      if (!down) return
      var dx = e.clientX - sx, dy = e.clientY - sy
      if (!moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        moved = true
        // 只有真正开始拖了才捕获指针：这样一次单纯的点击永远不会被捕获影响
        try { box.setPointerCapture(e.pointerId) } catch (err) {}
      }
      if (moved) place(box, ox + dx, oy + dy)
    })
    function up() {
      if (!down) return
      down = false
      box.style.cursor = 'grab'
      if (moved) save(box)
    }
    box.addEventListener('pointerup', up)
    box.addEventListener('pointercancel', up)
    // 拖动之后吞掉这一下 click，免得"拖完顺手按到按钮"
    box.addEventListener('click', function (e) {
      if (moved) { e.stopPropagation(); e.preventDefault(); moved = false }
    }, true)
    addEventListener('resize', function () {
      var r = box.getBoundingClientRect()
      place(box, r.left, r.top)
    })
  }

  function boot() {
    build()
    var box = el('dsh-pause-box')
    if (box) { restore(box); makeDraggable(box); box.title = '按住可以拖到任意位置；点「暂停」让我停在下一个边界' }
    poll(); setInterval(poll, 1000)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
`

function apply(root, config) {
  const prefix = String(config?.routePrefix ?? '/dsh-pause')
  let armed = false
  let holding = false
  let running = false          // 任务是否在跑（多条信号共同判定，见下）
  const recent = []            // 最近收到的事件名（排查用：/state 会回报）
  let lastSignal = 0
  let release = null

  const disposers = []
  root.effect(() => () => { for (const d of disposers) { try { d() } catch { /* ignore */ } } })

  // ① 桌面注入行 —— 必须第一时间注册，否则赶不上宿主启动时那次收集
  const rowText = '(function(){try{var d=document.body||document.head||document.documentElement;'
    + 'if(!d)return;var s=document.createElement("script");s.src="' + prefix + '/ui.js";'
    + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()'
  try {
    disposers.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (row && row.kind === 'script' && typeof row.text === 'string'
              && row.text.indexOf(prefix + '/ui.js') >= 0) return
        }
        table.push({ kind: 'script', placement: 'body', text: rowText })
      } catch { /* ignore */ }
    }))
  } catch { /* ignore */ }

  // ② 路由：按【路由对象】注册（kind / path / handler）
  root.inject(['webServer'], (ctx) => {
    const route = (path, handler) => {
      try {
        const off = ctx.webServer.register({ kind: 'exact', path, handler })
        disposers.push(() => { try { off?.() } catch { /* ignore */ } })
      } catch (err) {
        root.logger?.warn?.('[pause] 路由注册失败 ' + path + ': ' + String(err && err.message))
      }
    }
    route(prefix + '/ui.js', (req, res) => {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(UI_JS.replace('__PREFIX__', prefix))
    })
    route(prefix + '/state', (req, res) => {
      res.writeHead(200, JSON_HEADERS)
      // 90 秒没有任何事件 → 当作任务已结束（避免状态卡在 running）
      if (running && lastSignal > 0 && Date.now() - lastSignal > 90_000) running = false
      res.end(JSON.stringify({ armed, holding, running,
        recent, waitSeconds: Number(config?.waitSeconds ?? 0) }))
    })
    route(prefix + '/arm', (req, res) => {
      // 空闲时拒绝：没有任务在跑，暂停没有意义（作者要求）
      if (!running && !holding) {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, reason: 'idle', armed, holding, running }))
        return
      }
      // 已请求过 → 再点一次是【取消】
      armed = !armed
      root.logger?.info?.(armed
        ? '[pause] 已请求暂停 —— 下一步的边界会停住'
        : '[pause] 已取消暂停请求')
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ ok: true, armed, holding, running }))
    })
    route(prefix + '/release', (req, res) => {
      const fn = release
      release = null
      if (fn) fn('你点了继续')
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ armed, holding }))
    })
  })

  // ②½ 跟踪"任务是否在跑"，并在轮结束时作废未兑现的请求。
  //   ★ 为什么要作废：否则"上一轮点了暂停、但没赶上边界就结束了"
  //     会去停下一轮完全无关的任务。
  // ★ 为什么要多条通道：最初只挂了 turn/start 与 turn/end，
  //   结果界面一直显示"空闲中"（即任务在跑也没收到）——
  //   说明这类事件不在根上下文上。现在四路一起接：
  //   ① session/event（鲸鱼插件就是这么接的，会话作用域）② 直接挂 turn/* ③ agent/status
  //   ④ agent/pre-step（这个已经验证能收到，收到就证明任务在跑）。
  function note(name) {
    recent.push(name)
    if (recent.length > 12) recent.shift()
    lastSignal = Date.now()
  }
  function onTurnEvent(raw, event) {
    const t = String(event?.type ?? event?.kind ?? event?.name ?? raw ?? '')
    note(t || '(空事件名)')
    if (t.indexOf('turn/start') >= 0) running = true
    else if (t.indexOf('turn/end') >= 0) {
      running = false
      if (armed) {
        armed = false
        root.logger?.info?.('[pause] 这一轮已结束，未兑现的暂停请求已作废')
      }
    }
  }
  try { root.on('session/event', (session, event) => onTurnEvent(null, event)) } catch { /* ignore */ }
  try { root.on('turn/start', () => { note('turn/start'); running = true }) } catch { /* ignore */ }
  try { root.on('turn/end', () => onTurnEvent('turn/end', null)) } catch { /* ignore */ }
  try { root.on('agent/status', (p) => { const s = String(p?.status ?? p?.kind ?? ''); note('agent/status:' + s); if (s.indexOf('running') >= 0) running = true; if (s.indexOf('idle') >= 0) running = false }) } catch { /* ignore */ }

  // ③ 暂停点：只有 armed 时才拦，平时丝毫不干扰
  root.on('agent/pre-step', async (payload, next) => {
    // 收到 pre-step 本身就证明任务在跑（这条通道已实机验证）
    note('agent/pre-step')
    running = true
    if (!armed) return next()
    armed = false
    holding = true
    const step = payload?.step ?? '?'
    const seconds = Number(config?.waitSeconds ?? 0)
    root.logger?.info?.(`[pause] 已停在第 ${step} 步 —— 说完再继续`)
    await new Promise((resolve) => {
      let done = false
      let timer = null
      const off = root.on('user/message', () => finish('你说话了'))
      function finish(why) {
        if (done) return
        done = true
        try { off?.() } catch { /* ignore */ }
        if (timer) clearTimeout(timer)
        release = null
        holding = false
        root.logger?.info?.(`[pause] 继续（${why}）`)
        resolve()
      }
      release = finish
      if (seconds > 0) timer = setTimeout(() => finish('超时'), seconds * 1000)
    })
    return next()
  })

  root.logger?.info?.(`[pause] ready —— 界面左下角有「暂停」按钮，或 POST ${prefix}/arm`)
}

export { Config, apply, name }