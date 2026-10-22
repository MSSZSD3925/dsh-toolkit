# dsh-toolkit

我自用的三个小功能合成一个 DSH 插件（`dsh-tool-mcsrc` 除外）：

| 模块 | 文件 | 干什么 |
| --- | --- | --- |
| qq | `lib/qq.js` | 用 QQ 远程驾驶本 profile 里**已存在的会话**：注入消息、`#list`/`#new`/`#set`/`#msg`/`#last`/`#running`/`#start`/`#link`/`#check`/`#restart` |
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
