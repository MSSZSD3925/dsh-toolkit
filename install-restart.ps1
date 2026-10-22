<#
  一次性安装：把 restart.ps1 复制到 %USERPROFILE%\.dsh\ 并注册计划任务「DSH Restart Now」。

  计划任务存在的理由：DSH 自己的宿主进程被杀掉后，从它里面 spawn 出来的助手进程
  会连着一起消失（Job Object kill-on-close）。由任务计划服务来跑这份脚本，
  它在 DSH 进程树之外，杀完 DSH 还能继续执行「等进程清零 → 重新拉起」。

  用法：powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
        改过 DSH 安装路径就加 -Exe "D:\别的路径\DeepSeek Harness.exe"
#>
param(
  [string]$Exe = '<DSH 安装目录>\DeepSeek Harness.exe',
  [string]$LaunchTask = 'DSH Start',
  [string]$Task = 'DSH Restart Now'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dshDir = Join-Path $env:USERPROFILE '.dsh'
$dst = Join-Path $dshDir 'dsh-restart.ps1'

if (-not (Test-Path $dshDir)) { New-Item -ItemType Directory -Path $dshDir -Force | Out-Null }
Copy-Item (Join-Path $here 'restart.ps1') $dst -Force
Write-Host "脚本已复制到 $dst"

$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$dst"" -Task ""$LaunchTask"" -Exe ""$Exe"""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$settings.MultipleInstances = 'IgnoreNew'
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $Task -Action $action -Settings $settings -Principal $principal -Force | Out-Null

$t = Get-ScheduledTask -TaskName $Task
Write-Host "计划任务已注册：$($t.TaskName) / $($t.State)"
$t.Actions | ForEach-Object { Write-Host "  动作: $($_.Execute) $($_.Arguments)" }
Write-Host "验证：schtasks /Run /TN ""$Task""  （会真的重启 DSH）"
