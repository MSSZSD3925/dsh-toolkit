/**
 * dsh-toolkit —— 自研功能合并成的单个插件（mcsrc 除外）。
 *
 * 四部分，各自一个模块，互不依赖：
 *   qq.js       QQ ↔ DSH 远程驾驶：注入消息、路由、#list/#new/#check/#restart…
 *   pause.js    界面左下角的「暂停」按钮：在下一个步进边界停住等你补话
 *   restart.js  重启 DSH：由计划任务在进程树之外执行「杀掉 → 等清零 → 重新拉起」
 *   peak.js     贵时段纪律：只在工作日 9:00–12:00 / 14:00–18:00 出现在系统提示里
 *
 * 合并的理由：这三个都是"给我自己用的小功能"，拆成三个包要维护三份
 * package.json、三份 cordis.patch.yml、三次安装与三次重启，收益为零。
 */
import z from '@deepseek-ai/schemastery'
import * as pause from './pause.js'
import * as peak from './peak.js'
import * as qq from './qq.js'
import * as restart from './restart.js'

export const name = 'dsh-toolkit'

/** 三部分依赖的并集；webServer 由 pause 自己按需动态注入。 */
export const inject = ['tools', 'agents', 'sessions']

export const Config = z.object({
  qq: qq.Config,
  pause: pause.Config,
  restart: restart.Config,
  peak: peak.Config,
})

export function apply(ctx, config) {
  // 直接调用子模块时 cordis 不会替它们填默认值，这里统一按各自的 schema 解析一次。
  const c = Config(config ?? {})

  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')

  // qqApi 在 qq.apply 之后才有值；notify 用箭头函数延迟取，延后重启触发时已经就绪。
  let qqApi = null
  const notify = (text) => {
    try {
      qqApi?.broadcast?.(text)
    } catch {
      /* QQ 没连上时通知失败不影响重启 */
    }
  }

  restart.apply(ctx, c.restart, { agents, sessions, notify })
  pause.apply(ctx, c.pause)
  peak.apply(ctx, c.peak)
  qqApi = qq.apply(ctx, c.qq, {
    restart: (delaySecs, note, opts = {}) =>
      restart.scheduleRestart(
        c.restart,
        { delay_secs: delaySecs, note, force: opts.force === true, session_id: opts.session_id },
        { agents },
      ),
    cancelDeferred: () => restart.cancelDeferredRestart(c.restart),
    listBusy: () => restart.listRunningSessions(agents, ''),
  })

  // 上次排程重启时如果布置了续跑，这里把那个会话叫醒（每次启动至多一次）。
  // ctx 也传下去：续跑若需要冷 resume，必须带上当前选中的模型；
  // 空的 agentOptions 会把会话恢复成 provider/model 皆空的 agent，
  // 之后每一轮都在提示词组装阶段失败（{{model}} 取不到值）。
  void restart
    .runPendingResume(c.restart, { agents, sessions, ctx })
    .catch((err) => console.error('[dsh-toolkit] 续跑失败:', err))
}
