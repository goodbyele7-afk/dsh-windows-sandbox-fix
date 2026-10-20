@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ---- git is NOT on PATH on this machine; it ships inside the DSH ops bundle ----
set "GIT_BIN=C:\Users\Administrator\.dsh\dsh-ops\bash-ipc\7fc7dde8edb4a132c2563709\ucrt64\bin"
set "GIT=%GIT_BIN%\git.exe"

if not exist "%GIT%" (
  echo [X] git.exe not found at: %GIT%
  echo     Install Git for Windows:  winget install --id Git.Git -e
  pause
  exit /b 1
)

echo ================================================================
echo   Push to https://github.com/goodbyele7-afk/dsh-windows-sandbox-fix
echo ================================================================
echo.
"%GIT%" --version
echo.
echo   When asked for credentials:
echo     Username : goodbyele7-afk
echo     Password : a Personal Access Token (NOT your account password)
echo.
echo   Create one here ^(scope: repo, expiry 7 days is fine^):
echo     https://github.com/settings/tokens/new
echo.
echo ----------------------------------------------------------------
echo.

rem credential.helper is set to a broken helper-selector system-wide;
rem clearing it makes git prompt in this window instead of hanging.
set GIT_TERMINAL_PROMPT=1

set ATTEMPT=0
:retry
set /a ATTEMPT+=1
echo [attempt !ATTEMPT! of 5]
"%GIT%" -c credential.helper= push -u origin main
set "RC=%ERRORLEVEL%"

if "%RC%"=="0" goto success

rem 128 with a connection complaint is the flaky link here -- retry
if !ATTEMPT! lss 5 (
  echo.
  echo [!] failed ^(exit %RC%^) -- network to github.com is unreliable on this
  echo     machine; retrying in 4 seconds...
  echo.
  timeout /t 4 /nobreak >nul
  goto retry
)

echo.
echo [X] Gave up after 5 attempts.
echo.
echo     - If it said "Authentication failed", the token is wrong or lacks
echo       the 'repo' scope.
echo     - If it said "Could not connect" every time, GitHub is unreachable
echo       from this network right now. Try again later, or upload manually:
echo       https://github.com/goodbyele7-afk/dsh-windows-sandbox-fix/upload/main
echo.
pause
exit /b %RC%

:success
echo.
echo [OK] Pushed.
echo.
echo      https://github.com/goodbyele7-afk/dsh-windows-sandbox-fix
echo.
pause
exit /b 0
