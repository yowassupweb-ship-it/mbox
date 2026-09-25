@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -match 'node' -and $_.CommandLine -like '*claude-inbox-watcher.mjs*' }; foreach ($x in $p) { Write-Output ('stopping previous watcher pid ' + $x.ProcessId); Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }; if ($p) { Start-Sleep -Milliseconds 500 }"
set "MBOX_PROJECT=MBOX"
set "MBOX_AGENT_NAME=Claude"
set "MBOX_WATCH_AUTORESPOND=true"
set "MBOX_WATCH_BACKLOG=false"
if "%CLAUDE_WATCH_WORKDIR%"=="" set "CLAUDE_WATCH_WORKDIR=%~dp0.."
cd /d "%~dp0.."
node "%~dp0claude-inbox-watcher.mjs"
