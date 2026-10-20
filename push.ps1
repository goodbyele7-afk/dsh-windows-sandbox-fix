# Push this repo to GitHub.
#   powershell -ExecutionPolicy Bypass -File .\push.ps1

Set-Location -LiteralPath $PSScriptRoot

# git is NOT on PATH on this machine; it ships inside the DSH ops bundle.
$gitBin = 'C:\Users\Administrator\.dsh\dsh-ops\bash-ipc\7fc7dde8edb4a132c2563709\ucrt64\bin'
$git = Join-Path $gitBin 'git.exe'

if (-not (Test-Path $git)) {
  Write-Host "[X] git.exe not found at: $git" -ForegroundColor Red
  Write-Host '    Install Git for Windows:  winget install --id Git.Git -e'
  Read-Host 'Press Enter to exit'
  exit 1
}

Write-Host '==============================================================='
Write-Host '  Push to https://github.com/goodbyele7-afk/dsh-windows-sandbox-fix'
Write-Host '==============================================================='
& $git --version
Write-Host ''
Write-Host '  When asked for credentials:'
Write-Host '    Username : goodbyele7-afk'
Write-Host '    Password : a Personal Access Token (NOT your account password)'
Write-Host ''
Write-Host '  Create one here (scope: repo):'
Write-Host '    https://github.com/settings/tokens/new'
Write-Host '---------------------------------------------------------------'
Write-Host ''

# credential.helper is a broken helper-selector system-wide; clearing it
# makes git prompt in this window instead of hanging.
$env:GIT_TERMINAL_PROMPT = '1'

$rc = 128
for ($i = 1; $i -le 5; $i++) {
  Write-Host "[attempt $i of 5]"
  & $git -c credential.helper= push -u origin main
  $rc = $LASTEXITCODE
  if ($rc -eq 0) { break }
  if ($i -lt 5) {
    Write-Host ''
    Write-Host "[!] failed (exit $rc) -- github.com is unreliable from this network; retrying in 4s..." -ForegroundColor Yellow
    Write-Host ''
    Start-Sleep -Seconds 4
  }
}

Write-Host ''
if ($rc -eq 0) {
  Write-Host '[OK] Pushed.' -ForegroundColor Green
  Write-Host '     https://github.com/goodbyele7-afk/dsh-windows-sandbox-fix'
} else {
  Write-Host "[X] Gave up after 5 attempts (exit $rc)." -ForegroundColor Red
  Write-Host ''
  Write-Host "  - 'Authentication failed'  -> token wrong or missing the 'repo' scope."
  Write-Host '  - "Could not connect"       -> GitHub unreachable right now. Upload manually:'
  Write-Host '    https://github.com/goodbyele7-afk/dsh-windows-sandbox-fix/upload/main'
}
Read-Host 'Press Enter to exit'
