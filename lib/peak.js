/**
 * dsh-toolkit 的第四块：贵时段纪律，只在贵时段出现在系统提示里。
 *
 * 为什么做成插件而不是写进 AGENTS.md：写进常驻指令就是全天生效，模型无法判断
 * "现在是不是贵时段"，只好保守地一直执行（作者 2026-10-22 就是因为这个把
 * 工作区里那一节删掉的）。
 *
 * 判据与 dsh-context 统计成本用的窗口一致（它的 Je() 就是这么判的）：
 * 工作日北京时间 9:00–12:00 与 14:00–18:00 是贵时段；周六周日全天不算。
 * 窗口外的时刻，本段落返回空字符串，系统提示里完全看不到这几条规则。
 *
 * 实现要点：systemPrompt 的 section 允许 text 传函数，每次组装时求值，
 * 所以开关不需要重启，也不需要在时段边界做什么定时任务。
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-toolkit:peak'

export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关；关掉就永远不注入'),
  utc_offset_hours: z.number().default(8).description('判定窗口用的时区偏移（北京时间 8）'),
  morning: z.string().default('9-12').description('上午贵时段的起止小时，左闭右开'),
  afternoon: z.string().default('14-18').description('下午贵时段的起止小时，左闭右开'),
})

export const PEAK_TEXT = `# 省 token 时段（现在处于贵时段）

当前时间落在工作日北京时间 9:00–12:00 / 14:00–18:00 的贵时段里。在不影响任务完成的前提下按下面几条执行：

1. 少主动发挥：只做被明确要求的事。不顺手重构、不顺手美化、不顺手加机制。
2. 多确认下一步：每完成一件事，用一两行报告结果，然后问"下一步做什么"，不自己接着开下一件（除非已明确说了继续做某件）。
3. 先问再做大动作：涉及新内容、新数值、新文件、新机制时先确认口径；只读、只查、只报告的事可以直接做。
4. 回复短：能一行说清就不写三行；不复述已经说过的话；不重复贴长篇报告。
5. 省 token 但不省正确性：编译、校验、提交这些必要步骤照做；如果花费明显大于收益，先说清楚再决定。`

function parseWindow(spec, fallback) {
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(String(spec ?? '').trim())
  if (!m) return fallback
  const a = Number(m[1])
  const b = Number(m[2])
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b > 24 || a >= b) return fallback
  return [a, b]
}

/** 把"现在"换算成配置时区里的星期与小时，判断是否在贵时段。 */
export function peakState(config, now = Date.now()) {
  const offset = Number.isFinite(config?.utc_offset_hours) ? config.utc_offset_hours : 8
  const shifted = new Date(now + offset * 3600 * 1000)
  const day = shifted.getUTCDay() // 0=周日 6=周六
  const hour = shifted.getUTCHours()
  const weekend = day === 0 || day === 6
  const morning = parseWindow(config?.morning, [9, 12])
  const afternoon = parseWindow(config?.afternoon, [14, 18])
  const inMorning = hour >= morning[0] && hour < morning[1]
  const inAfternoon = hour >= afternoon[0] && hour < afternoon[1]
  const local = shifted.toISOString().slice(0, 13).replace('T', ' ') + ':00'
  return {
    isPeak: !weekend && (inMorning || inAfternoon),
    weekend,
    hour,
    local,
    window: `工作日 ${morning[0]}:00–${morning[1]}:00 / ${afternoon[0]}:00–${afternoon[1]}:00`,
  }
}

/**
 * 每次组装提示词都会调用注入函数的 text()，这里留一行痕迹，
 * 用来验证"这段到底有没有进系统提示、进的是哪一支分支"。
 * 日志是追加写的，一次组装一行，体积可以忽略。
 */
const TRACE_PATH = join(homedir(), '.dsh', 'dsh-toolkit-peak.log')

function trace(line) {
  try {
    appendFileSync(TRACE_PATH, `${new Date().toISOString()} ${line}
`, 'utf8')
  } catch {
    /* 记不上不影响注入 */
  }
}

/**
 * 调试用的强制开关：读 `~/.dsh/dsh-toolkit-peak.json` 里的 `force`。
 *   "on"  —— 当作贵时段（不用等到 9 点也能验证段落注入）
 *   "off" —— 当作非贵时段
 *   没有文件或别的值 —— 按真实时间判断
 * 每次求值都会重新读，改完立刻生效，不用重启。
 */
function forcedMode() {
  try {
    const raw = readFileSync(join(homedir(), '.dsh', 'dsh-toolkit-peak.json'), 'utf8')
    const v = JSON.parse(raw)?.force
    return v === 'on' || v === 'off' ? v : undefined
  } catch {
    return undefined
  }
}

export function apply(ctx, config) {
  ctx.inject(['systemPrompt'], (scoped) => {
    const sp = scoped.systemPrompt
    if (sp === undefined || sp === null || typeof sp.section !== 'function') {
      ctx.logger?.warn?.('[peak] 取不到 systemPrompt.section，贵时段段落未注入')
      return
    }
    let order = 1e6
    if (typeof sp.getSectionOrder === 'function') {
      const base = sp.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
      if (Number.isFinite(base)) order = base + 1000
    }
    const dispose = sp.section({
      name: 'dsh-toolkit:peak-hours',
      order,
      text: () => {
        if (!config.enabled) {
          trace('assemble: 开关关，返回空')
          return ''
        }
        const forced = forcedMode()
        if (forced === 'off') {
          trace('assemble: force=off，返回空')
          return ''
        }
        if (forced === 'on') {
          trace(`assemble: force=on，注入 ${PEAK_TEXT.length} 字符`)
          return PEAK_TEXT
        }
        const st = peakState(config)
        trace(`assemble: ${st.local} ${st.weekend ? '周末' : '工作日'}，${st.isPeak ? `注入 ${PEAK_TEXT.length} 字符` : '窗口外，返回空'}`)
        return st.isPeak ? PEAK_TEXT : ''
      },
      interpolate: false,
    })
    if (typeof dispose === 'function') ctx.effect(() => () => dispose())
    ctx.logger?.info?.(`[peak] 已注册贵时段段落 order=${order}（窗口 ${peakState(config).window}）`)
  })

  ctx.tools.register(
    defineTool({
      name: 'peak_status',
      description:
        '看贵时段纪律现在是否会注入：当前是否贵时段、本机时间、窗口、是否注入及原因，' +
        '以及调试强制开关（~/.dsh/dsh-toolkit-peak.json）。排查"为什么这条规则有时在、有时不在"时用。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            isPeak: { type: 'boolean', required: true },
            enabled: { type: 'boolean', required: true },
            local: { type: 'string', required: true },
            weekend: { type: 'boolean', required: true },
            window: { type: 'string', required: true },
            note: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `现在${value.isPeak ? '在注入' : '不注入'}（本机 ${value.local}，窗口 ${value.window}）
` +
              `总开关 ${value.enabled ? '开' : '关'}；周末：${value.weekend ? '是' : '否'}
${value.note}`,
          },
        ],
      },
      async execute() {
        const st = peakState(config)
        const forced = forcedMode()
        const inject = !config.enabled ? false : forced === 'on' ? true : forced === 'off' ? false : st.isPeak
        return {
          isPeak: inject,
          enabled: config.enabled,
          local: st.local,
          weekend: st.weekend,
          window: st.window,
          note: !config.enabled
            ? '总开关关着，永远不注入'
            : forced === 'on'
              ? '调试强制打开（~/.dsh/dsh-toolkit-peak.json force=on）：现在正在注入'
              : forced === 'off'
                ? '调试强制关闭（force=off）：现在不注入'
                : inject
                  ? '现在注入：系统提示里能看到那 5 条'
                  : st.weekend
                    ? '周末全天不注入'
                    : '窗口外，不注入',
        }
      },
    }),
  )
}
