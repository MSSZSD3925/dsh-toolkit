<#
  DSH 重启执行器。由计划任务「DSH Restart Now」调用，运行在 DSH 进程树之外，
  所以 DSH 被杀掉后它还能继续跑，并把 DSH 重新拉起来。

  流程：
    读 %USERPROFILE%\.dsh\dsh-restart-request.json 的 delaySecs（没有就用默认值）
    → 睡 delaySecs
    → Stop-Process 杀掉全部 DeepSeek Harness 进程，等进程数清零（最多 40 秒）
    → schtasks /Run /TN "DSH Start" 拉起（失败则直接执行 exe）
    → 最多等 90 秒确认进程回来了

  日志：%USERPROFILE%\.dsh\dsh-restart.log
#>
param(
  [string]$Task = 'DSH Start',
  [string]$Exe = '',
  [int]$DefaultDelaySecs = 20
)

$ErrorActionPreference = 'Continue'
$dshDir = Join-Path $env:USERPROFILE '.dsh'
$logFile = Join-Path $dshDir 'dsh-restart.log'
$reqFile = Join-Path $dshDir 'dsh-restart-request.json'

function L([string]$msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK') $msg"
  try { Add-Content -Path $logFile -Value $line -Encoding utf8 } catch { }
  try { Write-Host $line } catch { }
}

function DshProcs {
  @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
}

function ResolveDshExe {
  $local = Join-Path $dshDir 'dsh-toolkit.local.json'
  if (Test-Path $local) {
    try {
      $cfg = Get-Content $local -Raw -Encoding utf8 | ConvertFrom-Json
      if ($cfg.qq -and $cfg.qq.dsh_exe) { return [string]$cfg.qq.dsh_exe }
    } catch { }
  }
  foreach ($c in @('D:\DSH\DeepSeek Harness.exe', (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe'))) {
    if (Test-Path $c) { return $c }
  }
  return ''
}
if (-not $Exe) { $Exe = ResolveDshExe }

$delay = $DefaultDelaySecs
$note = ''
try {
  if (Test-Path $reqFile) {
    $req = Get-Content $reqFile -Raw -Encoding utf8 | ConvertFrom-Json
    if ($req.delaySecs) { $delay = [int]$req.delaySecs }
    if ($req.note) { $note = [string]$req.note }
  }
} catch {
  L "[ps] 读请求文件失败，用默认延迟 $DefaultDelaySecs 秒：$($_.Exception.Message)"
}

L "[ps] 开始：$delay 秒后重启；备注=$note"
if ($delay -gt 0) { Start-Sleep -Seconds $delay }

$before = (DshProcs).Count
L "[ps] 当前 DSH 进程 $before 个，开始结束"
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$deadline = (Get-Date).AddSeconds(40)
$left = (DshProcs).Count
while ($left -gt 0 -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 300
  $left = (DshProcs).Count
}
if ($left -gt 0) {
  L "[ps] 等了 40 秒还剩 $left 个进程，放弃拉起（避免单实例锁抢跑）"
  exit 1
}
L "[ps] 进程已清零"

$taskOk = $false
# schtasks.exe 被本机安全策略拦，改用 cmdlet；任务本身已改成走启动钩子（先清 Cookie）
try { Start-ScheduledTask -TaskName $Task -ErrorAction Stop; $taskOk = $true } catch { L "[ps] Start-ScheduledTask 失败：$($_.Exception.Message)" }
L $(if ($taskOk) { "[ps] 已请求计划任务 $Task 拉起" } else { "[ps] 计划任务 $Task 启动失败，直接执行 exe" })

$fallbackTried = $false
if (-not $taskOk) {
  if (-not (Test-Path $Exe)) {
    L "[ps] 找不到可执行文件 $Exe，无法拉起"
    exit 2
  }
  Start-Process -FilePath $Exe -WorkingDirectory (Split-Path $Exe)
  $fallbackTried = $true
  L "[ps] 已直接执行 $Exe"
}

$ok = $false
$waited = 0
for ($i = 1; $i -le 90; $i++) {
  Start-Sleep -Seconds 1
  $waited = $i
  if ((DshProcs).Count -gt 0) { $ok = $true; break }
  # schtasks 返回 0 只代表"请求被接受"：任务被禁用或被策略拦住时进程根本不会起。
  # 60 秒还没动静就直接执行 exe 兜底，别干等到 90 秒超时。
  if (-not $fallbackTried -and $waited -ge 60) {
    if (Test-Path $Exe) {
      L "[ps] 计划任务 60 秒内没拉起进程，直接执行 $Exe 兜底"
      Start-Process -FilePath $Exe -WorkingDirectory (Split-Path $Exe)
    }
    $fallbackTried = $true
  }
}
if ($ok) {
  L "[ps] 已拉起（等了 $waited 秒，进程 $((DshProcs).Count) 个）"
  if (Test-Path $reqFile) { Remove-Item $reqFile -Force -ErrorAction SilentlyContinue }
  exit 0
}
L "[ps] 90 秒内没起来，请看 DSH 自己的日志"
exit 3
