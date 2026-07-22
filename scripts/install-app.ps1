# VoiceNote desktop app one-line installer (Windows)
#
#   irm https://raw.githubusercontent.com/fastagent-sh/voicenote/main/scripts/install-app.ps1 | iex
#
# Downloads the packaged NSIS installer (self-contained: vn/bun/ffprobe/pi all bundled)
# → silent per-user install (%LOCALAPPDATA%, no admin) → launches it.
# The target machine needs no bun / pi / ffprobe / Rust.
#
# Override the download URL (testing or private distribution): $env:VOICENOTE_APP_URL = "file:///C:/path/VoiceNote-setup.exe"

$ErrorActionPreference = "Stop"

$Repo = if ($env:VOICENOTE_REPO) { $env:VOICENOTE_REPO } else { "fastagent-sh/voicenote" }
$Url  = if ($env:VOICENOTE_APP_URL) { $env:VOICENOTE_APP_URL } else {
  "https://github.com/$Repo/releases/latest/download/VoiceNote-setup.exe"
}

$Tmp = Join-Path $env:TEMP ("VoiceNote-setup-" + [guid]::NewGuid().ToString("N") + ".exe")

Write-Host "==> Downloading VoiceNote..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $Url -OutFile $Tmp

Write-Host "==> Installing (current user, no admin)..." -ForegroundColor Cyan
# NSIS silent install (/S). currentUser mode -> no UAC prompt.
Start-Process -FilePath $Tmp -ArgumentList "/S" -Wait
Remove-Item -Force $Tmp -ErrorAction SilentlyContinue

# Locate the installed exe (Tauri NSIS currentUser install dir varies by version).
$Candidates = @(
  (Join-Path $env:LOCALAPPDATA "Programs\VoiceNote\VoiceNote.exe"),
  (Join-Path $env:LOCALAPPDATA "VoiceNote\VoiceNote.exe")
)
$Exe = $Candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($Exe) {
  Write-Host "==> Launching..." -ForegroundColor Cyan
  Start-Process $Exe
} else {
  Write-Host "Installed, but VoiceNote.exe was not found at the default paths - launch VoiceNote from the Start menu." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "✅ Installed. First run:" -ForegroundColor Green
Write-Host "  1. The app lands on Settings - fill in your name + Volcano ASR/TOS keys + proxy, then save"
Write-Host "  2. In the Status panel, click 'Sign in to ChatGPT' (one-time browser authorization)"
Write-Host "  3. The background scheduled task enables automatically; plug in the recorder to transcribe and generate notes"
