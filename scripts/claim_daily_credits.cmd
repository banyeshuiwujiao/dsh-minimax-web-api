@echo off
rem ============================================================================
rem Claim the daily MiniMax credits (check-in) for the minimax2api account pool.
rem
rem Why a .cmd wrapper instead of putting the whole command line into the
rem scheduled task: schtasks /TR quoting breaks on paths with spaces, and there
rem would be no place to read the log. This file owns "what to run, where the
rem log goes, what to do on failure"; the scheduled task only calls it.
rem
rem The real logic is claim_daily_credits.py next to this file (Python). It
rem reuses minimax2api's own signing/proxy code instead of re-implementing
rem the protocol.
rem
rem Run it by hand (same thing the task does):
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
rem Step 2: claim today's credits for every account in the pool.
rem ---------------------------------------------------------------------------
"%PY%" "%~dp0claim_daily_credits.py" >>"%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo ==== %DATE% %TIME% exit=%RC% ==== >>"%LOG%"

rem Rotate the log: over 512KB the old copy becomes .1, so a daily task can
rem never fill the disk. Done in PowerShell to keep the cmd quoting sane.
powershell -NoProfile -Command "if ((Test-Path -LiteralPath $env:LOG) -and (Get-Item -LiteralPath $env:LOG).Length -gt 512KB) { Move-Item -Force -LiteralPath $env:LOG -Destination ($env:LOG + '.1') }" >nul 2>&1

exit /b %RC%
