# voicenote

Voice recordings → diarized transcripts → integrated semantic Markdown notes.

CLI command: `vn`

[中文文档 / Chinese documentation](README.zh-CN.md)

Currently tuned for the PHILIPS VTR6500 voice recorder, but the workflow is generic: scan recordings under a mount point → transcribe with speaker diarization → the selected summary model performs cleanup and process reconstruction → produce smart notes.

Today this is a CLI (`vn`). The desktop app is being rewritten on Electron; see
[Desktop app](#desktop-app) below.

## Install (CLI)

> The CLI installs from the npm package `@fastagent-sh/voicenote`. The install script / `bun add -g` below require the package to be **published to npm** (see "Development" at the end for the release flow).

Recommended: the install script (macOS):

```bash
curl -fsSL https://raw.githubusercontent.com/fastagent-sh/voicenote/main/scripts/install.sh | bash
```

The install script does **no interactive configuration** by default: it installs/checks `ffmpeg`, Node, and `vn` (pi ships with the package), then writes an editable `config.json` template. After installation, open the config file and fill in your keys and name:

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
bash <(curl -fsSL https://raw.githubusercontent.com/fastagent-sh/voicenote/main/scripts/install.sh)
```

The first install creates `~/.config/voicenote/config.json`. Once configured, run `vn doctor` to check it, and `vn install-launch-agent` if you want background monitoring.

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
'{"env":{"VOICENOTE_RECORD_DIR":"E:\\RECORD"}}' | vn config set
```

- Config: `%APPDATA%\voicenote\config.json`; logs/locks: `%LOCALAPPDATA%\voicenote\`
- Background automation uses the **Windows Task Scheduler**: `vn install-launch-agent` to register / `vn status` to inspect / `vn uninstall-launch-agent` to remove (same command names as macOS; dispatched per platform internally)

## Dependencies

- **Bun >= 1.3 (required at runtime)** — the code uses `Bun.Glob` / `Bun.file`; plain Node cannot run it
- pi (the notes backend) — a pinned dependency of this package, installed with it; no global `pi` needed
- ffmpeg / ffprobe (audio duration detection):

```bash
brew install ffmpeg
```

The install script only writes `vn` / Homebrew PATH entries to your shell config; app configuration lives in `~/.config/voicenote/config.json`. A manual setup needs at least:

```json
{
  "VOICENOTE_WORKSPACE": "/Users/you/Documents/meetings",
  "VOLCANO_ASR_KEY": "...",
  "VOLCANO_ASR_RESOURCE_ID": "volc.seedasr.auc",
  "speakers": {
    "self": { "name": "Your name", "aliases": ["nickname", "alias"] },
    "known": []
  }
}
```

An empty or missing key means "use the built-in default" — those defaults live in `src/cli.ts` and nowhere else, so the installer and the GUI leave such fields blank.

Optional settings:

```json
{
  "VOICENOTE_DEVICE_VOLUME": "VTR6500",
  "VOICENOTE_RECORD_DIR": "/Volumes/VTR6500/RECORD",
  "VOICENOTE_MAX_AGE_HOURS": "48",
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
vn import /path/to/audio.mp3    # copy one local recording into the durable manual-import queue
vn login                        # sign in to ChatGPT for the notes backend (browser callback; `--device-code` for headless machines). No pi TUI needed
vn upgrade                      # reinstall latest npm package
vn install-launch-agent
vn status
vn uninstall-launch-agent
```

## Configuration file

The install script writes an editable template:

```text
~/.config/voicenote/config.json     # workspace, Volcano ASR key, summary backend, your name/aliases, etc.
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

Changes take effect on the next `vn run`. `~`, `$HOME`, and `${HOME}` are accepted at the start of path settings. Environment variables override the file for the current CLI process; background runs use `config.json`, not shell startup files.

## Workflow

1. Scan recordings under `/Volumes/VTR6500/RECORD/`
2. Filter: ignore `._*`, small files (<100KB), short recordings (<60s), and already-processed recordings; if a previous run failed only at the summary stage and the transcript is saved, it is not considered done — processing resumes from there
3. Copy the original audio into `${VOICENOTE_WORKSPACE}/_audio/YYYY-MM/`
4. Transcribe with the Volcano Doubao large-model audio-file recognition API: post the audio bytes straight to the submit endpoint (no object storage), then poll for the result
5. Persist the raw transcript immediately after transcription (no lossy cleanup), so a later-stage failure never wastes the ASR spend
6. The summary model (default: pi codex via ChatGPT Plus) reads the raw transcript directly, performing necessary cleanup, speaker restoration, and reconstruction of views/debates/consensus inside the notes-generation stage; if the summary fails, the next `vn run` / `vn run --latest` reuses the saved transcript and retries only the notes generation — no `vn forget` needed
7. Write notes / metadata; the system makes no archiving decisions — files stay in the configured workspace

The history range defaults to 48 hours. In the GUI, choose 7 days, 30 days, or all recordings under **Settings → Recording history to process**. Expanding it re-evaluates recordings previously filtered as `too_old`; the dashboard's filtered summary links directly to this setting.

To process a local file immediately, drop one supported audio file onto the GUI. It is copied atomically to `${VOICENOTE_WORKSPACE}/_inbox`, queued even if another run is active or the recorder is disconnected, and processed before automatic recorder items without the automatic age/size/duration filters. The temporary inbox copy is removed after success and retained after failure for Retry. Imports are content-addressed, so dropping the same audio again opens the existing note instead of paying for ASR twice when a matching completed job is known.

A failing recording is retried on later runs, but at most **3 times** (whether it fails in transcription or in summarisation, and a run killed mid-job counts too). After that it is marked `Gave up` and left alone, so one broken file can't burn ASR/LLM budget on every scheduler tick. Use **Retry** on its GUI row to reset the budget, preserve saved outputs, and run it again; `vn forget <name>` is the CLI escape hatch that drops the record and re-queues it. Either path reuses a saved transcript instead of paying for ASR again. Both take the run lock, so retry after the active run finishes if the state file is busy.

Records whose source file is no longer on the recorder are forgotten on the next scan (and the removal is logged), *unless* they already produced notes or a transcript — that history is kept. This is why swapping recorders, or deleting files from the device, no longer leaves permanent "failed" rows behind.

## Output locations

`VOICENOTE_WORKSPACE` defaults to `~/Documents/meetings`.

- Notes entry point: `${VOICENOTE_WORKSPACE}/YYYY-MM/`
- Original audio: `${VOICENOTE_WORKSPACE}/_audio/YYYY-MM/`
- Full transcripts: `${VOICENOTE_WORKSPACE}/_transcripts/YYYY-MM/`
- Metadata: `${VOICENOTE_WORKSPACE}/_metadata/YYYY-MM/`
- Pending manual imports: `${VOICENOTE_WORKSPACE}/_inbox/` (removed after success)
- State: `${VOICENOTE_WORKSPACE}/_state/jobs.json` — one record per recording, holding its `state` — where it is in its lifecycle (`queued`, `running`, `done`, `filtered`, `error`, or `gave_up` once retries are spent) — plus a `code` saying why (`summary_failed`, `transcribe_failed`, `interrupted`, `too_small`, …), its attempt count and its output paths. `vn run` writes lifecycle updates; only explicit retry/forget actions mutate it otherwise. `vn jobs` and passive GUI refreshes are pure reads, so what you see is what will run. A pre-0.18 `processed.json` is converted automatically on the first run and kept as `processed.json.v1.bak`.
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

The LaunchAgent invokes `vn run` every 60 seconds. Without a recorder it still processes queued local imports; once the VTR6500 is connected, new recorder items are processed automatically too.

> `config.json` changes are picked up by the background agent on its next run. The plist stores only a fixed PATH and, when one was handed to the installer through the environment, the ffprobe path. Shell-only settings are deliberately not copied into the scheduler; persist them with `vn config set`. If the notes model or ASR is not configured, the agent skips before spending ASR.

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

Distribution: vn ships as **source** with no build step — it only runs on bun (shebang + `bun:ffi` + `engines.bun`), and bun runs TypeScript natively, so `bin` points straight at `src/cli.ts` and the npm tarball only contains `src/{cli,jobs,runLock,tos}.ts`. The install script / `vn upgrade` install from the published npm package (`bun add -g @fastagent-sh/voicenote`); a `git+https` install also works directly (the git tree carries the source; no build or install script needed).

Routine release (tag triggers CI):

```bash
npm version patch
git push --follow-tags
```

`package.json` is the CLI version source; `vn --version` reads it directly and CI rejects a mismatched `v*` tag.

The workflow lives at `.github/workflows/release.yml`: CI explicitly runs typecheck, tests, and an entry-point smoke test, then `npm publish --ignore-scripts` (deterministic publishing, no lifecycle dependence). Publishing uses **npm trusted publishing (OIDC)**: no long-lived token (`id-token: write` + a Trusted Publisher configured on npmjs.com), with provenance attached automatically. A bare local `npm publish` is still guarded by `prepublishOnly` (typecheck + tests).

> Both are already done for this package (Trusted Publisher configured, CI publishing since 0.18.0 with provenance), so a routine release needs nothing but the tag. Kept for forks: npm has no pending-publisher, so trusted publishing cannot publish a package's *very first* version — publish once manually with `npm login` + `npm publish --ignore-scripts`, then add a Trusted Publisher on the package settings page at npmjs.com (repo, workflow `release.yml`); CI takes over afterwards (the npm account needs 2FA).

## Desktop app

The Tauri desktop app was removed. Its replacement is an Electron app that runs
the pipeline inside its own process (no sidecar binaries, no background
LaunchAgent, pi used as a library through its SDK). Until it lands, the CLI
above is the whole product.

## License

MIT
