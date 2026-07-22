# VoiceNote desktop app

Self-contained macOS GUI (Tauri v2). Positioning: a status dashboard + quick access to notes; the actual transcription/notes pipeline runs autonomously via the background LaunchAgent using the **bundled engine**.

Full documentation (architecture / bundle contents / install / distribution / signing) lives in the "Desktop app" section of the repo root `README.md`.

```bash
bun install
bun run tauri dev          # development (runs ../src/cli.ts directly; no bundling, no background agent)
bun run tauri build        # build the .app only
bash scripts/package.sh    # build + sign + zip → release/VoiceNote-<version>.zip (ship this)
```

- `scripts/build-vn-sidecar.sh` — stages vn (compiled) / bun / ffprobe / pi into `binaries/` and `resources/` (gitignored)
- `scripts/sign-macos.sh` — inside-out deep signing (hardened runtime + JIT entitlements)
- `src-tauri/entitlements.plist` — JIT entitlements for bun/vn
