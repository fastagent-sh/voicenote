#!/usr/bin/env bash
set -euo pipefail

# VoiceNote desktop app one-line installer (macOS)
#
#   curl -fsSL https://raw.githubusercontent.com/fastagent-sh/voicenote/main/scripts/install-app.sh | bash
#
# Downloads the packaged .app (self-contained: bun/pi/ffprobe all bundled) → installs
# to /Applications → removes the quarantine flag (the only manual Gatekeeper step for
# un-notarized builds, done here for the user) → opens it.
# The target machine needs no bun / pi / ffprobe / global vn.
#
# Override the download URL (testing or private distribution): VOICENOTE_APP_URL=file:///path/to/VoiceNote.zip

REPO="${VOICENOTE_REPO:-fastagent-sh/voicenote}"
URL="${VOICENOTE_APP_URL:-https://github.com/$REPO/releases/latest/download/VoiceNote.zip}"
APP_NAME="VoiceNote.app"
LABEL="sh.fastagent.voicenote"
LABEL_LEGACY="com.kid7st.voicenote"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
err()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; }

[ "$(uname -s)" = "Darwin" ] || { err "macOS only."; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log "Downloading VoiceNote…"
curl -fSL "$URL" -o "$TMP/VoiceNote.zip"

log "Extracting…"
ditto -x -k "$TMP/VoiceNote.zip" "$TMP/out"
APP_SRC="$(find "$TMP/out" -maxdepth 2 -name "$APP_NAME" -type d | head -1)"
[ -n "$APP_SRC" ] || { err "$APP_NAME not found in the archive"; exit 1; }

# Prefer /Applications; fall back to ~/Applications when not writable
DEST_DIR="/Applications"
if [ ! -w "$DEST_DIR" ]; then DEST_DIR="$HOME/Applications"; mkdir -p "$DEST_DIR"; fi
DEST="$DEST_DIR/$APP_NAME"

# Upgrade-safe: stop the running agent/GUI so the existing bundle isn't locked
# while we replace it (a fresh install just no-ops these).
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/$LABEL_LEGACY" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL_LEGACY.plist"
pkill -f "$APP_NAME" 2>/dev/null || true
sleep 1

log "Installing to $DEST …"
rm -rf "$DEST"
ditto "$APP_SRC" "$DEST"

log "Removing quarantine flag…"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# Re-load the background agent if it was already installed (upgrade); a fresh
# install has no plist yet — the GUI installs+loads it on first launch.
if [ -f "$PLIST" ] && [ "$DEST_DIR" = "/Applications" ]; then
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
fi

log "Opening…"
open "$DEST"

cat <<EOF

✅ Installed: $DEST

First run:
  1. The app lands on Settings — fill in your name + your Volcano ASR/TOS keys + proxy, then save
  2. In the Status panel, click "Sign in to ChatGPT" (one-time browser authorization)
  3. The background agent enables automatically; plug in the recorder to transcribe and generate notes
EOF
