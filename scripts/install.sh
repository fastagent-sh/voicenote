#!/usr/bin/env bash
set -euo pipefail

# vn (voicenote CLI) installer for macOS. The desktop app is a separate
# download; this script only installs the command line tool.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/fastagent-sh/voicenote/main/scripts/install.sh | bash
#
# Optional preseed example (otherwise the installer writes editable templates):
#   VOICENOTE_NAME="Jane Doe" \
#   VOICENOTE_ALIAS="jane" \
#   VOICENOTE_WORKSPACE="$HOME/Documents/meetings" \
#   VOLCANO_ASR_KEY="..." \
#   bash scripts/install.sh

PACKAGE="@fastagent-sh/vn"
MIN_NODE="24.0.0"   # keep in sync with package.json engines.node (vn ships TypeScript
                    # sources and relies on Node's built-in type stripping)
LEGACY_PACKAGES=("@kid7st/voicenote" "@fastagent-sh/voicenote")  # pre-rebrand names; same `vn` bin → must be removed to avoid a stale symlink
INSTALL_LAUNCH_AGENT="${VOICENOTE_INSTALL_LAUNCH_AGENT:-}"
# Keys the editable template lists. Their default VALUES live in src/cli.ts — an
# empty entry here means "use vn's default", so defaults are defined once.
TEMPLATE_KEYS='VOICENOTE_WORKSPACE VOLCANO_ASR_KEY VOLCANO_ASR_RESOURCE_ID'

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33mWARN: %s\033[0m\n' "$*"; }
err() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; }

append_once() {
  local file="$1"
  local marker="$2"
  local content="$3"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  if grep -qF "$marker" "$file"; then
    log "Env block already exists in $file"
  else
    {
      echo ""
      echo "$marker"
      printf '%s\n' "$content"
      echo "# === /voicenote ==="
    } >> "$file"
    log "Wrote env block to $file"
  fi
}

# Only PATH goes into the shell rc (so the interactive shell finds vn and brew).
# All app config lives in ~/.config/voicenote/config.json (see write_config_json),
# which vn reads with precedence: process.env > config.json.
configure_shell_env() {
  log "Configuring PATH"
  local shell_name="$(basename "${SHELL:-}")"
  local path_line="export PATH=\"\$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:\$PATH\""
  case "$shell_name" in
    fish)
      if command -v fish >/dev/null 2>&1; then
        fish -lc "set -Ux PATH \$HOME/.local/bin /opt/homebrew/bin /opt/homebrew/sbin \$PATH"
        log "Configured fish PATH"
      else
        append_once "$HOME/.profile" "# === voicenote ===" "$path_line"
      fi
      ;;
    zsh) append_once "$HOME/.zshrc" "# === voicenote ===" "$path_line" ;;
    bash)
      if [[ -f "$HOME/.bash_profile" ]]; then
        append_once "$HOME/.bash_profile" "# === voicenote ===" "$path_line"
      else
        append_once "$HOME/.bashrc" "# === voicenote ===" "$path_line"
      fi
      ;;
    *) append_once "$HOME/.profile" "# === voicenote ===" "$path_line" ;;
  esac
  export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
}

# Seed ~/.config/voicenote/config.json through the CLI, so the accepted keys,
# validation and atomic write stay in src/cli.ts. Existing values win;
# environment variables fill the keys that are still empty.
write_config_json() {
  log "Preparing ~/.config/voicenote/config.json"
  local current payload
  if ! current="$(vn config get)"; then
    err "Could not read ~/.config/voicenote/config.json (see the error above). Fix the file or move it aside, then re-run this installer; nothing was written."
    exit 1
  fi
  payload="$(printf '%s' "$current" | TEMPLATE_KEYS="$TEMPLATE_KEYS" node -e '
let input = ""
process.stdin.on("data", (d) => { input += d })
process.stdin.on("end", () => {
  const current = JSON.parse(input).env ?? {}
  const env = {}
  for (const key of process.env.TEMPLATE_KEYS.split(" ")) {
    if (!current[key]) env[key] = process.env[key] || ""
  }
  const self = {}
  if (process.env.VOICENOTE_NAME) self.name = process.env.VOICENOTE_NAME
  if (process.env.VOICENOTE_ALIAS) self.aliases = [process.env.VOICENOTE_ALIAS]
  process.stdout.write(JSON.stringify(Object.keys(self).length ? { env, self } : { env }))
})
')"
  if ! printf '%s' "$payload" | vn config set >/dev/null; then
    err "Writing ~/.config/voicenote/config.json failed (see the error above); your existing config is unchanged."
    exit 1
  fi
}

install_deps() {
  log "Checking dependencies"
  if [[ "$(uname -s)" != "Darwin" ]]; then
    err "This installer currently supports macOS only."
    exit 1
  fi
  if ! command -v brew >/dev/null 2>&1; then
    err "Homebrew is required. Install it first: https://brew.sh/"
    exit 1
  fi
  if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
    brew install ffmpeg
  else
    log "ffmpeg/ffprobe already installed"
  fi
  if ! command -v node >/dev/null 2>&1; then
    brew install node
  fi
  # vn ships TypeScript and runs on Node's built-in type stripping, so an older
  # Node fails at startup with a syntax error. Check here, and let the user own
  # their Node install.
  local node_version
  node_version="$(node --version)"
  node_version="${node_version#v}"
  if [ "$(printf '%s\n%s\n' "$MIN_NODE" "$node_version" | sort -V | head -1)" != "$MIN_NODE" ]; then
    err "Node $node_version is too old; voicenote needs >= $MIN_NODE. Upgrade with: brew upgrade node"
    exit 1
  fi
  log "node $node_version"
  # pi is a pinned dependency of the voicenote package, installed with it below;
  # nothing global to install here.
}

remove_legacy() {
  # Pre-rebrand packages ship the same `vn` bin, so a leftover install can win the
  # PATH lookup and mask the new one. Earlier versions installed with bun, so
  # clean both package managers.
  for pkg in "${LEGACY_PACKAGES[@]}" "$PACKAGE"; do
    if command -v bun >/dev/null 2>&1 && bun pm ls -g 2>/dev/null | grep -q "$pkg"; then
      log "Removing bun-installed $pkg (voicenote now runs on Node)"
      bun remove -g "$pkg" 2>/dev/null || true
    fi
  done
  for pkg in "${LEGACY_PACKAGES[@]}"; do
    if npm ls -g "$pkg" >/dev/null 2>&1; then
      log "Removing legacy package $pkg (superseded by $PACKAGE)"
      npm uninstall -g "$pkg" 2>/dev/null || true
    fi
  done
}

install_voicenote() {
  remove_legacy
  log "Installing voicenote from npm package $PACKAGE"
  # `npm i -g` upgrades in place and leaves the existing install intact on
  # failure; set -e surfaces the npm error.
  npm i -g "$PACKAGE"
  vn --version || true
}

run_doctor() {
  if [[ "${VOICENOTE_RUN_DOCTOR:-0}" != "1" ]]; then
    log "Skipping vn doctor (run it after editing config.json)"
    return
  fi
  log "Running vn doctor"
  vn doctor || warn "vn doctor reported issues. Check output above."
}

install_launch_agent() {
  if [[ "$INSTALL_LAUNCH_AGENT" != "1" ]]; then
    log "Skipping LaunchAgent installation"
    return
  fi
  log "Installing LaunchAgent"
  vn install-launch-agent
  local plist="$HOME/Library/LaunchAgents/sh.fastagent.voicenote.plist"
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl enable "gui/$(id -u)/sh.fastagent.voicenote"
  vn status || true
}

main() {
  configure_shell_env
  install_deps
  install_voicenote
  write_config_json
  run_doctor
  install_launch_agent

  log "Done"
  cat <<EOF

Next steps:
  1. Edit config:
       open ~/.config/voicenote/config.json
       # or open the directory: vn open config
     Fill your Volcano ASR key and name/aliases in config.json.
  2. Configure pi credentials for your chosen model. ChatGPT users can run:
       vn login                 # browser callback; --device-code is optional
     Other providers use pi's /login or their API-key environment variable.
     Then confirm: vn doctor
  3. Optional: install background watcher after config is ready:
       vn install-launch-agent
  4. Insert PHILIPS VTR6500 and test:
       vn run --latest --dry-run
       vn run --latest
       vn list

Config lives in ~/.config/voicenote/config.json. Env vars override it for the current CLI process only.
Optional knobs (picked up automatically on the agent's next run):
  VOICENOTE_PI_THINKING=high          # summary reasoning effort
  VOICENOTE_PI_SUMMARY_TOOLS=""       # empty to disable read/grep cross-reference
  VOICENOTE_CONTEXT_DIR="\$HOME/vault" # read/grep root + agent cwd (default: workspace)
  See README for the full list.

Output (workspace shown by \`vn doctor\`):
  \${VOICENOTE_WORKSPACE}/YYYY-MM/

Logs:
  ~/.local/state/voicenote/logs/launchd.out.log
  ~/.local/state/voicenote/logs/launchd.err.log
EOF
}

main "$@"
