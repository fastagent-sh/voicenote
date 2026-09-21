# @fastagent-sh/voicenote

Installs the **VoiceNote desktop app** on macOS:

```bash
npx @fastagent-sh/voicenote
```

It downloads the latest release from
[GitHub](https://github.com/fastagent-sh/voicenote/releases), replaces any
existing copy, and puts `VoiceNote.app` in `/Applications`. The app updates
itself after that, so this command is only needed once (or to repair an
install).

Everything the app needs ships inside the bundle — no Node, no Bun, no
separate transcription tooling.

Looking for the command line tool? That is
[`@fastagent-sh/vn`](https://www.npmjs.com/package/@fastagent-sh/vn).
