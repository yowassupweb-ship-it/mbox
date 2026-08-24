@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -match 'node' -and $_.CommandLine -like '*codex-chat-watcher.mjs*' }; if ($p) { exit 10 }"
if "%ERRORLEVEL%"=="10" exit /b 0
set "MBOX_PROJECT=MBOX"
set "MBOX_AGENT_NAME=Codex"
set "MBOX_WATCH_AUTORESPOND=true"
set "MBOX_WATCH_BACKLOG=false"
if "%CODEX_WATCH_WORKDIR%"=="" set "CODEX_WATCH_WORKDIR=%~dp0.."
cd /d "%~dp0.."
node "%~dp0codex-chat-watcher.mjs"
