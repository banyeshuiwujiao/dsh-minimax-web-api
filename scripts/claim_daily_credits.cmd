@echo off
rem ============================================================================
rem Run the whole MiniMax account-pool maintenance chain by hand:
rem   1. ensure_v2rayn_minimax_proxy.py  (repair the overseas egress rule)
rem   2. keep_tokens_alive.py             (renew the 1-hour OAuth tokens)
rem   3. claim_daily_credits.py          (claim today's credits, every region)
rem
rem The real logic lives in the Python scripts next to this file; they reuse
rem minimax2api's own signing/proxy code instead of re-implementing the protocol.
rem
rem AUTOMATION NOW LIVES IN THE PLUGIN: lib/credits.js runs the same three
rem scripts on plugin startup and every 30 minutes after that. The Windows
rem scheduled task that used to call this file was deleted on 2026-10-23.
rem This file is kept as a manual one-shot entry point (it is the only place
rem that owns the log file and the exit code).
rem
rem Run it by hand:
rem     scripts\claim_daily_credits.cmd
rem Read the log:
rem     %USERPROFILE%\.dsh\logs\minimax-claim.log
rem
rem NOTE: this file is deliberately ASCII-only. cmd.exe reads .cmd in the system
rem ANSI codepage (GBK here), so UTF-8 Chinese comments turn into mojibake that
rem then breaks the rest of the file's parsing.
rem ============================================================================
setlocal enabledelayedexpansion

set "PY=C:\Users\Admin\DeepSeek_Harness\git-repo\minimax2api\.venv\Scripts\python.exe"
set "SCRIPT=%~dp0claim_daily_credits.py"
set "LOGDIR=%USERPROFILE%\.dsh\logs"
set "LOG=%LOGDIR%\minimax-claim.log"

if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1

echo ==== %DATE% %TIME% start ==== >>"%LOG%"

if not exist "%PY%" (
    echo [FATAL] python interpreter not found: %PY% >>"%LOG%"
    echo [FATAL] backend venv is gone; rerun the plugin install.ps1 to rebuild it >>"%LOG%"
    echo ==== %DATE% %TIME% exit=2 ==== >>"%LOG%"
    exit /b 2
)

if not exist "%SCRIPT%" (
    echo [FATAL] script not found: %SCRIPT% >>"%LOG%"
    echo ==== %DATE% %TIME% exit=2 ==== >>"%LOG%"
    exit /b 2
)

rem The log is UTF-8 regardless of the system codepage, so it stays readable.
set "PYTHONIOENCODING=utf-8"
set "PYTHONUNBUFFERED=1"

rem ---------------------------------------------------------------------------
rem Step 1: make sure v2rayN still routes *.minimax.io through the proxy.
rem Without that rule the overseas account (agent.minimax.io) answers 307 to the
rem CN site and the global check-in dies. The rule lives in v2rayN's routing
rem presets, so a preset switch or a v2rayN update can drop it.
rem Exit code 2 from the checker means "I fixed it, but v2rayN must be restarted".
rem ---------------------------------------------------------------------------
"%PY%" "%~dp0ensure_v2rayn_minimax_proxy.py" >>"%LOG%" 2>&1
if errorlevel 2 echo [WARN] v2rayN minimax proxy rule was re-added - RESTART v2rayN to make it effective >>"%LOG%"

rem ---------------------------------------------------------------------------
rem Step 2: renew the OAuth tokens. They live one hour; an expired one shows up
rem as "minimax llm HTTP 401" and retires the account, which empties the pool.
rem The backend's own keepalive has two holes here (it does not restore a
rem retired account, and it only acts when the token is nearly expired), so the
rem plugin does it too. Harmless when the token is still fresh.
rem ---------------------------------------------------------------------------
"%PY%" "%~dp0keep_tokens_alive.py" >>"%LOG%" 2>&1
if errorlevel 1 echo [WARN] token renewal reported a failure - see the lines above >>"%LOG%"

rem ---------------------------------------------------------------------------
rem Step 3: claim today's credits for every account in the pool.
rem ---------------------------------------------------------------------------
"%PY%" "%~dp0claim_daily_credits.py" >>"%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo ==== %DATE% %TIME% exit=%RC% ==== >>"%LOG%"

rem Rotate the log: over 512KB the old copy becomes .1, so a daily task can
rem never fill the disk. Done in PowerShell to keep the cmd quoting sane.
powershell -NoProfile -Command "if ((Test-Path -LiteralPath $env:LOG) -and (Get-Item -LiteralPath $env:LOG).Length -gt 512KB) { Move-Item -Force -LiteralPath $env:LOG -Destination ($env:LOG + '.1') }" >nul 2>&1

exit /b %RC%
