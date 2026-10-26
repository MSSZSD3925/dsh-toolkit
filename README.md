# dsh-toolkit

我自用的三个小功能合成一个 DSH 插件（`dsh-tool-mcsrc` 除外）：

| 模块 | 文件 | 干什么 |
| --- | --- | --- |
| qq | `lib/qq.js` | 用 QQ 远程驾驶本 profile 里**已存在的会话**：注入消息、路由与会话管理、审批/提问镜像、本轮提权、文件回传、进度推送——命令清单见下面的「QQ 远程驾驶」一节 |
| pause | `lib/pause.js` | 界面左下角的暂停按钮：在下一个步进边界停住等你补话 |
| restart | `lib/restart.js` | 重启 DSH；可选「重启后自动续跑」 |

合并的理由：三个都是"给我自己用的小功能"，拆三个包要维护三份
`package.json`、三份 `cordis.patch.yml`、三次安装与三次重启。

## 安装

    dsh plugin --profile desktop add link:<插件目录>
    powershell -ExecutionPolicy Bypass -File .\install-restart.ps1

装完**必须**核对 `C:\Users\<you>\.dsh\profiles\desktop\package.json` 的
`dsh.profile.bundles` 里有 `dsh-toolkit`：CLI 被 pnpm 的构建脚本拦下时会中止，
bundles 可能漏写，表现为重启后插件静默不生效。

改了 `lib/` 之后要重启 DSH 才生效——可以直接用 `dsh_restart` 工具。

## 配置

`cordis.patch.yml` 是分组的：`qq:` / `pause:` / `restart:` 分别对应三个模块的
Config。**键必须与 schema 完全一致**，多一个键严格校验就让整个插件加载失败，
而失败只写在启动 DSH 的终端里，现象是"装好了但一点反应都没有"。

换个机器要改的键：`qq.allow_users`（QQ 号白名单，空列表等于拒收所有人）、
`qq.napcat_path`、`qq.dsh_exe`、`restart.*_path`。

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
| `#restart [秒]` | 重启 DSH（默认 15 秒后），改完插件用它生效 |
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

### 与配置有关的键

除 `enable`/`ws_url`/`allow_users` 这些必须项外，上面功能对应：
`approval_remote`、`approval_timeout_secs`、`questions_remote`、
`question_timeout_secs`、`progress_secs`、`link_proxy_port`、`link_public_host`。
`cordis.patch.yml` 里没写的键走 schema 默认值；**多写一个不存在的键会让插件加载失败**。

## 重启（restart）

模型调 `dsh_restart`（或 QQ 里发 `#restart`），插件写请求文件并触发计划任务
「DSH Restart Now」；任务由**任务计划服务**执行，所以它在 DSH 进程树之外，
能杀完 DSH 再把它拉回来。

环境约束：

1. 不能从 DSH 进程内部"杀自己再 spawn"——桌面宿主用 Job Object（kill-on-close）
   挂子进程，宿主一死，从它里面 spawn 的助手进程一起消失。
2. `.ps1` 必须存成 UTF-8 **带 BOM**：PowerShell 5.1 读无 BOM 的脚本按 GBK 解码，
   中文变乱码并报语法错。
3. 注册计划任务用 `Register-ScheduledTask`，不要拼 `schtasks /Create /TR`——
   嵌套引号会被拆开。校验点：`Get-ScheduledTask -TaskName 'DSH Restart Now'` 存在且 State=Ready。

## 重启后自动续跑

排程重启时给 `dsh_restart` 带上 `resume_prompt`，插件会把
`{ sessionId, prompt, attempts, max, expireAt }` 写到 `~/.dsh/dsh-toolkit-resume.json`
（在 DSH 进程之外的磁盘上，重启杀不掉的只有这个）。下次启动时
`lib/index.js` 调一次 `runPendingResume`，把那条提示注入同一个会话，
让被打断的任务自己接着干。

三层防死循环：

1. 单条任务最多 `resume_max` 次（默认 2，硬上限 5），用完即删记录。
2. 布置有 TTL（`resume_ttl_secs`，默认 900 秒，从预计重启时刻算），过期丢弃。
3. 窗口计数器 `~/.dsh/dsh-toolkit-resume.json.guard`：30 分钟内累计满 5 次就停，
   即使反复重新布置也会被拦。

校验点：

- 布置成功：`~/.dsh/dsh-restart.log` 出现 `[restart] 已布置自动续跑：session-…`
- 续跑生效：重启后同一份日志出现 `[resume] 已注入续跑 1/2 -> session-…`
- 该会话里会出现一条以"（自动续跑 1/2：…）"开头的用户消息
