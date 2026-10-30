# dsh-toolkit

我自用的四个小功能合成一个 DSH 插件（`dsh-tool-mcsrc` 除外）：

| 模块 | 文件 | 干什么 |
| --- | --- | --- |
| qq | `lib/qq.js` | 用 QQ 远程驾驶本 profile 里**已存在的会话**：注入消息、路由与会话管理、审批/提问镜像、本轮提权、文件回传、进度推送——命令清单见下面的「QQ 远程驾驶」一节 |
| pause | `lib/pause.js` | 界面左下角的暂停按钮：在下一个步进边界停住等你补话 |
| restart | `lib/restart.js` | 重启 DSH；可选「重启后自动续跑」 |
| peak | `lib/peak.js` | 贵时段纪律：只在工作日 9:00–12:00 / 14:00–18:00 把「省 token 五条」注入系统提示，其余时间整段不出现 |

合并的理由：四个都是"给我自己用的小功能"，拆四个包要维护四份
`package.json`、三份 `cordis.patch.yml`、三次安装与三次重启。

## 安装

    dsh plugin --profile desktop add link:C:/Users/<you>/Documents/deepseek-harness/default-workspace/_tools/dsh-toolkit
    powershell -ExecutionPolicy Bypass -File .\install-restart.ps1

装完**必须**核对 `C:\Users\<you>\.dsh\profiles\desktop\package.json` 的
`dsh.profile.bundles` 里有 `dsh-toolkit`：CLI 被 pnpm 的构建脚本拦下时会中止，
bundles 可能漏写，表现为重启后插件静默不生效。

改了 `lib/` 之后要重启 DSH 才生效——可以直接用 `dsh_restart` 工具。

## 配置

`cordis.patch.yml` 是分组的：`qq:` / `pause:` / `restart:` 分别对应三个模块的
Config。写成 schema 里有的键；写错的键不会让插件加载失败（schemastery 的 object
是非 strict 的，未知键会被原样 merge 进 config 后忽略），但那个配置也就等于没写，
排查时容易误以为生效了。三个模块的配置键风格统一为 snake_case；pause 的旧键
`routePrefix` / `waitSeconds` 仍被兼容读取。

换个机器要改的键：`qq.allow_users`（QQ 号白名单，空列表等于拒收所有人）、
`qq.napcat_path`、`qq.dsh_exe`、`restart.*_path`。

### 本机真值放本地覆盖文件

仓库是公开的，`cordis.patch.yml` 里只有占位符（`123456789`、`<NapCat 安装目录>`…）。
真值写在 `${DSH_HOME:-~/.dsh}/dsh-toolkit.local.json`，插件启动时深合并覆盖模板：

```json
{
  "qq": { "allow_users": [392593439], "napcat_path": "D:/…", "dsh_exe": "D:/…" },
  "restart": { "log_path": "C:/Users/…/dsh-restart.log",
               "request_path": "C:/Users/…/dsh-restart-request.json",
               "resume_path": "C:/Users/…/dsh-toolkit-resume.json" }
}
```

只写要覆盖的键，数组与标量直接替换。文件不存在或 JSON 坏了只告警、不影响启动；
启动日志出现 `[dsh-toolkit] 本地配置已合并：…` 就说明生效了。

这样 `git checkout/reset/pull` 冲掉 `cordis.patch.yml` 也不会把 QQ 白名单和路径一起
冲成占位符——2026-10-30 23:46 的一次 reset 就因此让重启静默失效、QQ 全部失联。

**从终端启动 DSH** 用 `_tools/start-dsh.cmd`：它会清掉 `ELECTRON_RUN_AS_NODE`
（否则 exe 被当 Node 跑、秒退），再让计划任务 `DSH Start` 拉起（shell 起的进程会随
会话结束被回收；本机 `schtasks.exe` 被安全策略拦，脚本里用的是 cmdlet）。


pause 段的键：`pause.route_prefix`（默认 `/dsh-pause`）、`pause.wait_seconds`
（没人管时多少秒自动继续，0 表示一直等）。

## QQ 远程驾驶（qq）

`qq.apply(ctx, config, hooks)` 把 QQ（OneBot / NapCat 正向 WebSocket）接成这个
profile 的第二块屏幕：消息注入的是「你本人发的普通消息」，电脑上的会话照常继续。

### 命令

| 命令 | 作用 |
| --- | --- |
| `#list [页码]` / `#ls` | 列出会话与路由（排除子智能体与已归档；编号随活动变，别名和短 id 才稳） |
| `#new` | 新建一个对话并设为默认路由 |
| `#check` | 新建对话做一次自检，结论发回 QQ |
| `#set <路由>` / `#use` / `#pin` | 设定默认会话，重启 DSH 也不丢 |
| `#start` | 查 OneBot / NapCat 状态，没起来就拉起并等登录 |
| `#link` | 取一个手机能打开的网页链接（局域网/隧道，本次运行有效） |
| `#restart [秒]` | 重启 DSH（默认 20 秒后）；有别的对话在跑时先等它们跑完，回一份「短编号 + 标题 + 任务」清单 |
| `#restart force` | 不等待、立刻重启；要再发一次 `#restart confirm` 二次确认（2 分钟内有效） |
| `#restart cancel` | 取消推迟中的重启 |
| `#running` | 列出正在运行的会话（带停止提示） |
| `#stop [路由]` | 停掉正在输出的会话，等价客户端停止按钮（中断当前轮 + 清排队消息） |
| `#msg [路由]` / `#last [路由]` | 该会话最新的一条助手回复 / 你自己发的最后一条 |
| `#status` | 连接状态、当前路由、待回话轮次、待回答提问、待审批、提权状态 |
| `#<路由> 内容` / `#内容` | 把内容注入指定会话 / 默认会话 |
| `#help` | 上面这份用法 |

### 审批与提问镜像

`approval/request` 与 `user-questions/request` 都是 cordis waterfall。插件用
`ctx.on(event, listener, { prepend: true, global: true })` 抢在最前，同时把请求
原样 `next()` 给下游，于是**界面卡片照常弹、QQ 侧也能回**，谁先答听谁的。

- 审批：`【远程审批 0001】` 推送 → `#y 0001` / `#n 0001`（只有一条时可省编号）；
  超时（`approval_timeout_secs`，默认 300 秒）整条交回界面。
- 提问：`【远程提问 Q0001】` 推送 → `#answer Q0001 1:2 2:1,3`；纯文字当自定义回答，
  未答的题按「跳过」提交（`selected: []`）。超时（`question_timeout_secs`，默认
  1800 秒）后问题在投影里变成 continued，此时迟到的 `#answer` 改走
  `userQuestions.answer()` 补投给模型。
- 镜像自己发起的提问没有 `tool/call` 投影记录，判活时不能只查投影
  （见 `entry.projected`）——否则会被当成「已经答过」清掉。
- `#testask` 是自检入口：插件自己发一道多选题，用来验证整条链路。

### 本轮提权（#escalate）

`#escalate [路由]` → 确认提示；`#escalate confirm` → 生效（2 分钟内有效）。
生效期间该会话的审批一律按 `allowed-once` 放行，连挂着的待审批也一并放行；
agent 从 running 回到 idle 时自动撤销并推一条「提权结束」，兜底上限 2 小时，
`#escalate off` 可手动收回。命令词只认整词，不接受缩写。

边界：它放行的是**审批层**，DSH 沙箱策略不变——被沙箱挡住的操作不会因此穿透。

### 文件与进度

- `#file <路径>`：把本机文件/图片发到 QQ（`upload_private_file`）；`~` 会展开，
  超过 100 MB 拒绝，路径不对会明确报错。模型侧对应工具 `onebot_send_file`。
- `#progress [秒|off]`：定时推送在跑会话的最新输出（间隔夹在 10–3600 秒），
  `progress_secs > 0` 时 DSH 启动即自动开。
  每条推送带会话标题与最新一条助手正文的摘要。

### 局域网代理的边界

`#link` 在没有远程插件或拿不到公网地址时，会起一个本机代理（`link_proxy_port`，
默认 62566）转发到 DSH 的 webserver。代理监听 `0.0.0.0`，但只接受来自局域网/本机
地址的连接（回环、10/8、192.168/16、172.16–31、100.64/10、169.254/16、IPv6 ULA），
其他来源直接断开；转发时把 Host/Origin/Referer 改写成回环地址，让上游当成 loopback。
也就是说：**能连到这个端口、并且已经拿到链接的人**，在 DSH 眼里就是本机用户。
只在一个你信得过的网络里开它；`#link` 的链接本次运行有效。

### 与配置有关的键

除 `enable`/`ws_url`/`allow_users` 这些必须项外，上面功能对应：
`approval_remote`、`approval_timeout_secs`、`questions_remote`、
`question_timeout_secs`、`progress_secs`、`link_proxy_port`、`link_public_host`。
`cordis.patch.yml` 里没写的键走 schema 默认值；**多写一个不存在的键会让插件加载失败**。

## 重启（restart）

模型调 `dsh_restart`（或 QQ 里发 `#restart`），插件写请求文件并触发计划任务
「DSH Restart Now」；任务由**任务计划服务**执行，所以它在 DSH 进程树之外，
能杀完 DSH 再把它拉回来。

### 有别的任务在跑时先等

默认不打断正在跑的对话：`dsh_restart`（或 `#restart`）发现其它会话处于运行态
就不立刻排程，只记一条「延后重启」，每 2 秒看一次，等这些会话全部回到 idle
才写请求文件、触发计划任务。返回与 QQ 回复里会列出这些会话的
**短编号、标题和正在做的任务**（任务取最后一条用户消息，去掉 QQ 注入前缀）。

- 客户端（`dsh_restart`）：返回 `status: waiting` 和一份 `busy` 清单；提示模型用
  `ask_user_question` 问用户是否要立刻重启（提问会按已有配置镜像到 QQ）。
  用户同意后，用 `force: true` 加上次返回的 `force_token` 再调一次，
  令牌 60 秒有效、一次性，用来保证「问过用户」。
- QQ（`#restart`）：直接在 QQ 回清单和两个后续命令，
  `#restart force` → 再回清单 → `#restart confirm` 才真正强制重启（2 分钟内有效，
  `#restart cancel` 取消）。QQ 路径不需要模型参与。
- `action=cancel` / `#restart cancel` 取消还在等待的延后重启。
- 延后重启真的触发时，会用 `broadcast` 给白名单里的 QQ 用户各发一条通知。
- 延后状态只存在内存里：DSH 真重启后自然消失；等待期间手动关掉 DSH 也不会误触发。
- 频率提醒：客户端每次启动都会往 `127.0.0.1` 追加一条 `dsh-auth-*` Cookie 且从不回收，
  累计约 60 条后请求头会越过本地 Host 的 16 KB 上限，启动报
  「desktop welcome: Web authentication failed」（实际是 431）。重启越频繁越容易踩；
  踩到时清掉 `Network/Cookies` 里 `127.0.0.1` 的 `dsh-auth-*` 即可，
  `~/.dsh/.credentials.yaml` 不用动。新加的「等任务跑完再重启」也顺带减少了无谓重启。

环境约束：

1. 不能从 DSH 进程内部"杀自己再 spawn"——桌面宿主用 Job Object（kill-on-close）
   挂子进程，宿主一死，从它里面 spawn 的助手进程一起消失。
2. `.ps1` 必须存成 UTF-8 **带 BOM**：PowerShell 5.1 读无 BOM 的脚本按 GBK 解码，
   中文变乱码并报语法错。
3. 注册计划任务用 `Register-ScheduledTask`，不要拼 `schtasks /Create /TR`——
   嵌套引号会被拆开。校验点：`Get-ScheduledTask -TaskName 'DSH Restart Now'` 存在且 State=Ready。
4. 重启脚本里 `schtasks /Run` 返回 0 只代表"请求被接受"，任务被禁用或被策略拦住时
   进程不会起来；脚本会在第 60 秒仍没看到进程时直接执行 exe 兜底。

请求文件的清理：正常路径由 `restart.ps1` 在成功后删除；触发失败、或续跑布置失败时
插件自己回滚；`dsh_restart action=status` 也会把明显过期的请求文件清掉，
不会永远显示「待执行」。日志 `dsh-restart.log` / `dsh-qq-router.log` 超过 2 MB 时
滚成 `.1`，只留一份旧的。

## 重启后自动续跑

排程重启时给 `dsh_restart` 带上 `resume_prompt`，插件会把
`{ sessionId, prompt, attempts, max, expireAt }` 写到 `$DSH_HOME`（没设就是
`~/.dsh`）下的 `dsh-toolkit-resume.json`
（在 DSH 进程之外的磁盘上，重启杀不掉的只有这个）。下次启动时
`lib/index.js` 调一次 `runPendingResume`，把那条提示注入同一个会话，
让被打断的任务自己接着干。

三层防死循环：

1. 单条任务最多 `resume_max` 次（默认 2，硬上限 5），用完即删记录。
2. 布置有 TTL（`resume_ttl_secs`，默认 900 秒，从预计重启时刻算），过期丢弃。
3. 窗口计数器 `dsh-toolkit-resume.json.guard`（与记录同目录）：30 分钟内累计满 5 次就停，
   即使反复重新布置也会被拦。

注入成功之后才删记录（注入失败会保留，下次启动按剩余次数重试），并立刻
`sessions.flush` 落盘。

续跑的两个兜底：

- **模型路由**：界面选中的路由如果是 `deepseek-official`，而 `~/.dsh/.credentials.yaml`
  里没有对应 key，就换成 `deepseek-account`（同模型）再注入。不换的后果是会话被钉在
  没有凭证的路由上，每轮在发请求前就失败，表现为"静默不回复"。判定依据是凭证文件里
  出现 `deepseek-official` 且其后 600 字符内有 `apiKey` / `api_key` / `DEEPSEEK_API_KEY` / `key:`。
  日志对应行：`[resume] 默认模型路由 deepseek-official 没有凭证，续跑改用 deepseek-account/…`。
- **Agent 预设**：冷启动 resume 必须带 `agentPreset` + `setup`（`agentPresets.resolve(undefined)`
  之后 `mount`）。不带预设时被恢复的 agent 只有全局注册的插件工具，read/write/bash 这类
  标准工具不会出现，现象就是"基础工具全消失"。启动早期预设可能还没注册完，`resolve`
  会抛 `Unknown agent preset: standard`，所以这里最多重试 20 秒再放弃。
  校验点：日志出现 `冷启动 resume 使用的模型：…，预设：standard`，且续跑后的会话里
  read/glob 可以正常调用。

`qq_waker install` 会生成三份文件：`waker.config.json`（UTF-8 JSON）、
`waker-launch.vbs`（UTF-16LE，登录自启用，路径含中文也不会丢字符）、
`waker-start.ps1`（UTF-8 BOM，计划任务「DSH Start」跑它；里面先看 DSH 进程在不在，
已在跑就直接退出，避免和 `restart.ps1` 同时拉起两个实例）。

校验点：

- 布置成功：`~/.dsh/dsh-restart.log` 出现 `[restart] 已布置自动续跑：session-…`
- 续跑生效：重启后同一份日志出现 `[resume] 已注入续跑 1/2 -> session-…`
- 该会话里会出现一条以"（自动续跑 1/2：…）"开头的用户消息

## 贵时段纪律（peak）

只在**工作日北京时间 9:00–12:00 与 14:00–18:00** 出现在系统提示里；其余时间
（含周末全天、午休、晚上）这一段返回空字符串，上下文里根本看不到这 5 条规则。

为什么做成插件：写进常驻 AGENTS.md 就是全天生效，模型看不到"现在几点"只好一直执行；
这里是 `systemPrompt.section({ text: 函数 })`，每次组装提示词时求值，跨界自动切换，
不需要定时任务，也不需要重启。

判据与 dsh-context 统计成本用的窗口一致（它的 `Je()` 就是按工作日 9–12、14–18 判的）。

调试（`peak_status` 工具能看当前判定）：

    ~/.dsh/dsh-toolkit-peak.json   内容 {"force":"on"}   → 当作贵时段，立刻注入
                                   内容 {"force":"off"}  → 当作非贵时段
                                   删掉文件             → 按真实时间判断

不用重启，每次求值重读这个文件。验证方式：开一个子会话，问它系统提示里有没有
「省 token 时段（现在处于贵时段）」这一段。
