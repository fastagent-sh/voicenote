# voicenote

Voice recordings → diarized transcripts → integrated semantic Markdown notes.

CLI command: `vn`

[中文文档 / Chinese documentation](README.zh-CN.md)

Currently tuned for the PHILIPS VTR6500 voice recorder, but the workflow is generic: scan recordings under a mount point → transcribe with speaker diarization → the selected summary model performs cleanup and process reconstruction → produce smart notes.

**Two ways to use it:**

- 🖥️ **Desktop app (GUI)** — for non-terminal users, a self-contained `.app`, one-line install:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/fastagent-sh/voicenote/main/scripts/install-app.sh | bash
  ```
  See [Desktop app](#desktop-app-gui-app) below.
- ⌨️ **CLI (`vn`)** — for terminal users / developers, see "Install (CLI)" below.

## Install (CLI)

> The CLI installs from the npm package `@fastagent-sh/voicenote`. The install script / `bun add -g` below require the package to be **published to npm** (see "Development" at the end for the release flow).

Recommended: the install script (macOS):

```bash
curl -fsSL https://raw.githubusercontent.com/fastagent-sh/voicenote/main/scripts/install.sh | bash
```

The install script does **no interactive configuration** by default: it installs/checks `ffmpeg`, Bun, Node/npm, pi, and `vn`, then writes an editable `config.json` template. After installation, open the config file and fill in your keys and name:

```bash
open ~/.config/voicenote/config.json
# or open the directory
vn open config
```

Advanced users can preseed the template with environment variables:

```bash
VOICENOTE_NAME="Jane Doe" \
VOICENOTE_ALIAS="jane" \
VOICENOTE_WORKSPACE="$HOME/Documents/meetings" \
VOLCANO_ASR_KEY="..." \
VOLCANO_TOS_BUCKET="..." \
VOLCANO_TOS_ACCESS_KEY="..." \
VOLCANO_TOS_SECRET_KEY="..." \
bash <(curl -fsSL https://raw.githubusercontent.com/fastagent-sh/voicenote/main/scripts/install.sh)
```

The first install creates `~/.config/voicenote/config.json`. A legacy `speakers.json` is still read for compatibility and migrated into `config.json.speakers`. Once configured, run `vn doctor` to check the environment, and `vn install-launch-agent` if you want background monitoring.

Manual install:

```bash
bun remove -g @kid7st/voicenote 2>/dev/null || true   # drop the pre-rebrand package if present (safe no-op otherwise)
bun add -g @fastagent-sh/voicenote
mkdir -p ~/.local/bin
ln -sf ~/.bun/bin/vn ~/.local/bin/vn
```

An older `git+…#main` install is replaced in place by `bun add -g @fastagent-sh/voicenote`. The one exception is the **pre-rebrand `@kid7st/voicenote`** package: it ships the same `vn` bin, so the `bun remove -g` line above clears it first (the one-line `install.sh` does this automatically).

### Windows (CLI)

The CLI is cross-platform. Prerequisites: Bun, ffmpeg (provides `ffprobe.exe`), Node + pi.

```powershell
bun remove -g @kid7st/voicenote 2>$null   # drop the pre-rebrand package if present (safe no-op otherwise)
bun add -g @fastagent-sh/voicenote
# Windows has no /Volumes mount points; set the recorder drive explicitly
setx VOICENOTE_RECORD_DIR "E:\RECORD"
```

- Config: `%APPDATA%\voicenote\config.json`; logs/locks: `%LOCALAPPDATA%\voicenote\`
- Background automation uses the **Windows Task Scheduler**: `vn install-launch-agent` to register / `vn status` to inspect / `vn uninstall-launch-agent` to remove (same command names as macOS; dispatched per platform internally)

## Dependencies

- **Bun >= 1.3 (required at runtime)** — the code uses `Bun.Glob` / `Bun.file`; plain Node cannot run it
- Node / npm — only used to install the pi CLI (the notes backend)
- ffmpeg / ffprobe (audio duration detection):

```bash
brew install ffmpeg
```

The install script only writes `vn` / Bun / Homebrew PATH entries to your shell config; app configuration lives in `~/.config/voicenote/config.json`. A manual setup needs at least:

```json
{
  "VOICENOTE_WORKSPACE": "/Users/you/Documents/meetings",
  "VOLCANO_ASR_KEY": "...",
  "VOLCANO_ASR_RESOURCE_ID": "volc.seedasr.auc",
  "VOLCANO_TOS_REGION": "cn-guangzhou",
  "VOLCANO_TOS_ENDPOINT": "tos-s3-cn-guangzhou.volces.com",
  "VOLCANO_TOS_BUCKET": "...",
  "VOLCANO_TOS_ACCESS_KEY": "...",
  "VOLCANO_TOS_SECRET_KEY": "...",
  "VOLCANO_TOS_KEEP": "0",
  "speakers": {
    "self": { "name": "Your name", "aliases": ["nickname", "alias"] },
    "known": []
  }
}
```

Optional settings:

```json
{
  "VOICENOTE_DEVICE_VOLUME": "VTR6500",
  "VOICENOTE_RECORD_DIR": "/Volumes/VTR6500/RECORD",
  "VOICENOTE_MAX_AGE_HOURS": "48",
  "VOICENOTE_PI_BIN": "pi",
  "VOICENOTE_PI_MODEL": "openai-codex/gpt-5.6-sol",
  "PI_CODING_AGENT_DIR": "$HOME/.config/voicenote/pi-agent",
  "VOICENOTE_PI_THINKING": "high",
  "VOICENOTE_PI_SUMMARY_TOOLS": "read,grep",
  "VOICENOTE_CONTEXT_DIR": "/Users/you/vault"
}
```

### Which model writes the notes

`VOICENOTE_PI_MODEL` is passed straight to pi as `--model`. pi accepts
`provider/id`, so one value pins both (`openai-codex/gpt-5.6-sol`). Leave it unset
and pi's own configured default model is used.

Credentials always belong to pi (`pi` → `/login <provider>`, or a provider API key
in the environment); voicenote never picks a provider and never falls back to a
second one. If pi fails, the transcript is kept and the summary can be retried
with `vn run --latest`.

### Credentials of their own

`PI_CODING_AGENT_DIR` relocates pi's config directory, which is where it keeps
`auth.json`. Point it at a voicenote-owned directory and `vn login` writes there,
pi refreshes the tokens there, and an interactive pi session cannot clobber
them — it rewrites its own `auth.json` wholesale on exit, which has silently
dropped providers before:

```bash
echo '{"env":{"PI_CODING_AGENT_DIR":"$HOME/.config/voicenote/pi-agent"}}' | vn config set
vn login   # signs in and stores credentials in that directory
```

`vn doctor` prints the path it will read (`pi.auth=...`).

`DEEPSEEK_API_KEY` and `OPENAI_API_KEY` in the config are only forwarded to pi's
environment for providers that read them.

Transient failures (dropped socket, 5xx, 429) are retried on the same provider up
to `VOICENOTE_PI_RETRIES` times (default 3). Quota and auth errors are not
retried.

## Usage

```bash
vn doctor                       # check environment and config
vn run                          # default: Volcano ASR + pi notes
vn run --mode transcript        # transcript only, skip semantic notes
vn run --latest                 # process only the latest valid recording
vn run --latest --force         # re-run the latest one
vn run --pdf                    # additionally render a PDF after notes
vn run --dry-run                # print the plan only
vn run /path/to/audio.m4a       # process one file by path (skips the scan, ignores age/size/duration filters)
vn list                         # list this month's notes
vn list --month 2026-05         # specific month
vn last                         # print the latest processing summary
vn open                         # open the notes directory in Finder
vn open config                  # open ~/.config/voicenote/
vn open logs                    # open the logs directory
vn open <slug>                  # open a note by filename fragment
vn forget <id|filename>         # let a recording be processed again
vn log                          # print today's log tail (--lines N / -f follow / --err include launchd.err / --date YYYY-MM-DD)
vn errors                       # print recent ERROR logs
vn login                        # sign in to ChatGPT for the notes backend (browser callback; `--device-code` for headless machines). No pi TUI needed
vn upgrade                      # reinstall latest npm package
vn install-launch-agent
vn status
vn uninstall-launch-agent
```

## Configuration file

The install script writes an editable template:

```text
~/.config/voicenote/config.json     # workspace, Volcano ASR/TOS, summary backend, your name/aliases, etc.
```

`speakers` maps Speaker A/B/C back to real names; `known` lists known contacts:

```json
{
  "speakers": {
    "self": { "name": "Your name", "aliases": ["nickname", "alias"] },
    "known": []
  }
}
```

Changes take effect on the next `vn run`. Config values and unquoted/double-quoted `.zshrc` exports support simple `$VAR` / `${VAR}` references to other settings and `$HOME`. Single-quoted shell values stay literal. Shell commands are never executed. Runtime references honor inherited environment values; scheduler comparisons resolve from files alone.

A legacy `~/.config/voicenote/speakers.json` is still read as a compatibility fallback.

## Workflow

1. Scan recordings under `/Volumes/VTR6500/RECORD/`
2. Filter: ignore `._*`, small files (<100KB), short recordings (<60s), and already-processed recordings; if a previous run failed only at the summary stage and the transcript is saved, it is not considered done — processing resumes from there
3. Copy the original audio into `${VOICENOTE_WORKSPACE}/_audio/YYYY-MM/`
4. Transcribe with the Volcano Doubao large-model audio-file recognition API: upload local audio to TOS, submit the job, poll for results, and delete the TOS object by default when done
5. Persist the raw transcript immediately after transcription (no lossy cleanup), so a later-stage failure never wastes the ASR spend
6. The summary model (default: pi codex via ChatGPT Plus) reads the raw transcript directly, performing necessary cleanup, speaker restoration, and reconstruction of views/debates/consensus inside the notes-generation stage; if the summary fails, the next `vn run` / `vn run --latest` reuses the saved transcript and retries only the notes generation — no `vn forget` needed
7. Write notes / metadata; the system makes no archiving decisions — files stay in the configured workspace

A failing recording is retried on later runs, but at most **3 times** (whether it fails in transcription or in summarisation, and a run killed mid-job counts too). After that it is marked `Gave up` and left alone, so one broken file can't burn ASR/LLM budget on every scheduler tick — `vn forget <name>` drops the record and re-queues it. Re-queuing is not the same as re-transcribing: if the transcript is already on disk it is reused, so `vn forget` never re-pays for ASR. (`vn forget` takes the run lock, so it refuses while a run is in progress — wait for that run to finish and repeat.)

Records whose source file is no longer on the recorder are forgotten on the next scan (and the removal is logged), *unless* they already produced notes or a transcript — that history is kept. This is why swapping recorders, or deleting files from the device, no longer leaves permanent "failed" rows behind.

## Output locations

The installer defaults to `VOICENOTE_WORKSPACE=~/Documents/meetings`.

- Notes entry point: `${VOICENOTE_WORKSPACE}/YYYY-MM/`
- Original audio: `${VOICENOTE_WORKSPACE}/_audio/YYYY-MM/`
- Full transcripts: `${VOICENOTE_WORKSPACE}/_transcripts/YYYY-MM/`
- Metadata: `${VOICENOTE_WORKSPACE}/_metadata/YYYY-MM/`
- State: `${VOICENOTE_WORKSPACE}/_state/jobs.json` — one record per recording, holding its `state` — where it is in its lifecycle (`queued`, `running`, `done`, `filtered`, `error`, or `gave_up` once retries are spent) — plus a `code` saying why (`summary_failed`, `transcribe_failed`, `interrupted`, `too_small`, …), its attempt count and its output paths. `vn run` is the only writer; `vn jobs` and the GUI dashboard are pure reads of it, so what you see is what will run. A pre-0.18 `processed.json` is converted automatically on the first run and kept as `processed.json.v1.bak`.
- Index: `${VOICENOTE_WORKSPACE}/_index/notes.jsonl`

## Automation

The install script can set this up automatically. Manual setup:

```bash
vn install-launch-agent
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/sh.fastagent.voicenote.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/sh.fastagent.voicenote.plist
launchctl enable gui/$(id -u)/sh.fastagent.voicenote
vn status
```

The LaunchAgent invokes `vn run` every 60 seconds. It skips safely when no recorder is plugged in; once the VTR6500 is connected, new recordings are processed automatically.

> Config changes (`config.json` or `~/.zshrc`) are picked up automatically by the background agent on its next run — no reinstall needed. The plist only snapshots real environment variables and pi's absolute path: **after changing `VOICENOTE_PI_BIN`, re-run `vn install-launch-agent` and reload** (`vn upgrade` regenerates the plist automatically). If pi is not signed in or ASR is not configured, the agent skips processing instead of burning ASR spend.
>
> Proxy values that match the file configuration, including expanded variable references, are not embedded and produce no override warning. Values supplied only by the shell, or differing from the files, are embedded as explicit overrides. To clear an unwanted override, update or unset the shell variable, then run `vn install-launch-agent --load`. Prefer `LOCAL_PROXY_HOST`/`LOCAL_PROXY_PORT` in `config.json` for proxy configuration.

Logs:

```text
~/.local/state/voicenote/logs/launchd.out.log
~/.local/state/voicenote/logs/launchd.err.log
```

## Development

```bash
git clone https://github.com/fastagent-sh/voicenote.git
cd voicenote
bun install
bun run typecheck
bun src/cli.ts doctor
```

Distribution: vn ships as **source** with no build step — it only runs on bun (shebang + `bun:ffi` + `engines.bun`), and bun runs TypeScript natively, so `bin` points straight at `src/cli.ts` and the npm tarball only contains `src/{cli,envConfig,jobs,runLock}.ts`. The install script / `vn upgrade` install from the published npm package (`bun add -g @fastagent-sh/voicenote`); a `git+https` install also works directly (the git tree carries the source; no build or install script needed).

Routine release (tag triggers CI):

```bash
npm version patch   # then sync `VERSION` in src/cli.ts to match
git push --follow-tags
```

`src/cli.ts` hardcodes `VERSION` for `vn --version`, and `npm version` does not touch it — update both in the same commit or the CLI will report a version it isn't.

The workflow lives at `.github/workflows/release.yml`: CI explicitly runs typecheck/test/build + an artifact smoke test, then `npm publish --ignore-scripts` (deterministic publishing, no lifecycle dependence). Publishing uses **npm trusted publishing (OIDC)**: no long-lived token (`id-token: write` + a Trusted Publisher configured on npmjs.com), with provenance attached automatically. A bare local `npm publish` is still guarded by `prepublishOnly` (typecheck+test+build).

> Both are already done for this package (Trusted Publisher configured, CI publishing since 0.18.0 with provenance), so a routine release needs nothing but the tag. Kept for forks: npm has no pending-publisher, so trusted publishing cannot publish a package's *very first* version — publish once manually with `npm login` + `npm publish --ignore-scripts`, then add a Trusted Publisher on the package settings page at npmjs.com (repo, workflow `release.yml`); CI takes over afterwards (the npm account needs 2FA).

## Desktop app (GUI, `app/`)

A self-contained macOS `.app` (Tauri v2) for **non-terminal users**: the target machine needs no pre-installed bun / pi / ffprobe / global `vn`.

**Positioning**: the GUI is only a "status dashboard + quick access to output" — it does **not** drive processing. The full pipeline runs autonomously every 60s via the background LaunchAgent using the bundled engine (it keeps running with the GUI closed).

- First run: settings (identity / Volcano keys / proxy). The notes model comes from pi; ChatGPT users can sign in from the Status panel (`vn login`'s browser-callback flow).
- After that: the main view shows agent activity + recent notes (open note / open folder)

### What's bundled

`bun build --compile` compiles the `vn` engine (bun runtime + pi-ai included) into a single-file sidecar; pi cannot be compiled (it reads data files from disk at runtime), so the whole package ships alongside and runs with a bundled `bun`:

| Component | Form | Purpose |
|------|------|------|
| `vn` (compiled) | externalBin | pipeline + ChatGPT sign-in |
| `bun` | externalBin | runs pi |
| `ffprobe` (native arm64 static) | externalBin | audio duration (pi only needs ffprobe, not all of ffmpeg) |
| `pi` + node_modules | resource | notes backend (ChatGPT, OpenAI API, or DeepSeek) |

At runtime, Rust generates a wrapper (`exec <bundled bun> <bundled pi/cli.js> "$@"`) and injects `VOICENOTE_PI_BIN` / `VOICENOTE_FFPROBE_BIN` into `vn`. Release builds are **universal** (x86_64 + arm64; vn/bun/ffprobe each merged with `lipo`; pi is JS and needs none).

### Build

Prerequisites: Rust + cargo, bun, node/npm, Xcode CLT, and **pi installed globally on the build machine** (`npm i -g @earendil-works/pi-coding-agent`; the build script stages pi from there).

```bash
cd app
bun install
bun run tauri build
# Output: src-tauri/target/release/bundle/macos/VoiceNote.app
```

**Windows** (build on Windows with Rust + MSVC C++ build tools; WebView2 is preinstalled on Win10/11, NSIS is downloaded by Tauri automatically):

```powershell
cd app
bun install
bun run tauri build --config src-tauri/tauri.windows.conf.json
# Output: app\src-tauri\target\release\bundle\nsis\VoiceNote_<version>_x64-setup.exe
```

Windows uses `scripts/build-vn-sidecar.ps1` to stage `vn.exe` (`--windows-hide-console`, no console window) / `bun.exe` / `ffprobe.exe` + pi; `tauri.windows.conf.json` produces the NSIS installer (currentUser, no admin).

`beforeBuildCommand` first runs `scripts/build-vn-sidecar.sh` to stage vn/bun/ffprobe/pi (`binaries/` and `resources/` are gitignored; pi/ffprobe copying is idempotent). For development use `bun run tauri dev` (dev mode runs `../src/cli.ts` directly, no bundling, no background agent install).

### How users install (one line, recommended)

> This is separate from the CLI `install.sh` above: the CLI script targets developers (installs bun/pi/vn); this one targets **non-technical users** (download .app → /Applications).

```bash
curl -fsSL https://raw.githubusercontent.com/fastagent-sh/voicenote/main/scripts/install-app.sh | bash
```

**Windows** (one line, no admin):

```powershell
irm https://raw.githubusercontent.com/fastagent-sh/voicenote/main/scripts/install-app.ps1 | iex
```

`install-app.ps1` downloads the NSIS installer from the GitHub Release (self-contained vn/bun/ffprobe/pi) → silent install into `%LOCALAPPDATA%` (no admin) → launches it.

`install-app.sh` downloads the packaged `.app` from GitHub Releases → installs to `/Applications` → **removes the quarantine flag for the user** (Gatekeeper bypass for un-notarized builds) → opens it. The target machine needs no bun/pi/ffprobe/global vn (all bundled).

**First launch**: the app lands on Settings. Fill in identity, your Volcano ASR/TOS keys, and proxy as needed. Notes are written by pi with pi's own provider and model; for ChatGPT, click "Sign in to ChatGPT" in the Status panel. Saving installs and loads the background LaunchAgent using the bundled engine. Once credentials are configured, plug in the recorder for automatic transcription and notes.

> The background agent label is `sh.fastagent.voicenote` (same as the CLI version; only one exists per machine). If the `.app` is moved, open it once to recalibrate the plist.

**Upgrades**: since 0.1.9 the app has a built-in updater — open the app → "Settings → Software update" → "Check for updates"; when a new version appears, click "Download & install"; the app restarts automatically with config/notes preserved. For first installs, or upgrades from 0.1.8 and earlier (which had no updater), re-run the one-line install script above.

> **Windows, from 0.1.11 or earlier**: those builds point their updater at the pre-rebrand repo, which still exists and stops at 0.1.11 — "Check for updates" therefore always reports "up to date". The bundle identifier changed in the same rebrand, so re-running the installer does *not* replace them; both copies stay installed under the same name. Uninstall the old VoiceNote (Settings → Apps) first, then run the one-line install. Config and notes are untouched by the uninstall.

### Maintainers: packaging + release

**Automatic (recommended)**: push an `app-v*` tag to trigger `.github/workflows/release-app.yml`:

```bash
git tag app-v0.1.0 && git push --tags
```

**One `app-v*` tag = one Release covering mac + Windows.** `release-app.yml` is a single workflow: mac (universal + ad-hoc deep signing) and Windows (NSIS) build in parallel, then the `release` job publishes. Each Release carries:

- **First-install packages** `VoiceNote.zip` (mac) / `VoiceNote-setup.exe` (win) — fetched by `install-app.*` from `releases/latest/download/...`;
- **Updater artifacts** `VoiceNote.app.tar.gz` + `latest.json` — used by the in-app Tauri updater (Settings → Software update).

> The updater needs signing secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (generated with `tauri signer generate`; the public key goes in `tauri.conf.json`); the `preflight` job blocks the release while the pubkey is still a placeholder.

> Use `app-v*` (distinct from the CLI's `v*` npm release tags). Artifacts are **universal** (x86_64 + arm64), working on both Intel and Apple Silicon.

**Manual**:

```bash
cd app
bash scripts/package.sh          # → app/release/VoiceNote-<version>.zip (~110MB)
gh release create app-v0.1.0 app/release/VoiceNote-<version>.zip#VoiceNote.zip -t "VoiceNote 0.1.0" -n "Desktop app"
```

The asset name must be **`VoiceNote.zip`** (`install-app.sh` fetches `releases/latest/download/VoiceNote.zip`). For local testing bypass the Release with: `VOICENOTE_APP_URL=file:///path/to/VoiceNote.zip bash scripts/install-app.sh`.

### Signing / notarization (no `xattr`, double-click to run)

JIT entitlements are in place (`src-tauri/entitlements.plist`: `allow-jit` etc. for bun/vn; referenced from `tauri.conf.json`). `scripts/sign-macos.sh` performs inside-out deep signing (hardened runtime + entitlements):

```bash
# Internal ad-hoc (JIT verified to survive under hardened runtime)
bash scripts/sign-macos.sh /Applications/VoiceNote.app

# Official distribution (requires a Developer ID certificate, Apple Developer Program $99/yr)
bash scripts/sign-macos.sh VoiceNote.app "Developer ID Application: NAME (TEAMID)"
xcrun notarytool submit ... && xcrun stapler staple VoiceNote.app
```

## License

MIT
