#!/usr/bin/env bash
set -euo pipefail

# One command to produce a shippable VoiceNote.app zip.
#
#   bash scripts/package.sh                                  # ad-hoc (internal)
#   bash scripts/package.sh "Developer ID Application: …"    # for notarization
#
# Builder prerequisites: Rust+cargo, bun, node/npm, Xcode CLT, and pi installed
# globally (npm i -g @earendil-works/pi-coding-agent) — build-vn-sidecar.sh
# stages pi from there. End users need none of this; it's all bundled.

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(dirname "$HERE")"
cd "$APP"
IDENTITY="${1:--}"
VER="$(node -p "require('./src-tauri/tauri.conf.json').version" 2>/dev/null || echo dev)"
BUNDLE="src-tauri/target/universal-apple-darwin/release/bundle/macos/VoiceNote.app"
OUT="release/VoiceNote-$VER.zip"

echo "==> Building universal (x86_64 + arm64; stages vn/bun/ffprobe/pi, then bundles) …"
bun install >/dev/null 2>&1 || true
bun run tauri build --target universal-apple-darwin

echo "==> Signing ($IDENTITY) …"
bash scripts/sign-macos.sh "$BUNDLE" "$IDENTITY"

echo "==> Zipping …"
mkdir -p release
rm -f "$OUT"
ditto -c -k --keepParent "$BUNDLE" "$OUT"

# Updater artifact (CI only; needs the signing key). A .tar.gz of the SIGNED
# .app + its minisign signature, so a one-click update installs the SAME
# hardened-signed bundle as the zip — sidecars keep their JIT entitlements.
# Tauri's own createUpdaterArtifacts runs at build time, BEFORE sign-macos.sh,
# so its tar.gz would ship an unsigned sidecar; we repackage post-sign here.
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "==> Updater artifact (tar.gz + sig of signed .app) …"
  TARGZ="release/VoiceNote.app.tar.gz"
  rm -f "$TARGZ" "$TARGZ.sig"
  tar -czf "$TARGZ" -C "$(dirname "$BUNDLE")" "VoiceNote.app"
  # Invoke the binary directly (not via `bun run`): `bun run tauri … --password ""`
  # drops the empty arg and misaligns the FILE positional. The signer reads
  # TAURI_SIGNING_PRIVATE_KEY(_PASSWORD) from the env CI already exports.
  ./node_modules/.bin/tauri signer sign "$TARGZ"
  echo "✓ $TARGZ (+ .sig)"
fi

echo
echo "✅ Output: $APP/$OUT  ($(du -h "$OUT" | cut -f1))"
echo
if [ "$IDENTITY" = "-" ]; then
  cat <<EOF
Not notarized (internal distribution). Send the zip to users and have them paste this one line in a terminal:

  unzip -o ~/Downloads/VoiceNote-$VER.zip -d /Applications \\
    && xattr -dr com.apple.quarantine /Applications/VoiceNote.app \\
    && open /Applications/VoiceNote.app

(The xattr line is the only manual Gatekeeper bypass for un-notarized builds; with Developer ID notarization it can be dropped — double-click just works.)
EOF
else
  cat <<EOF
Signed with Developer ID. Notarize next, then it installs by double-click:

  xcrun notarytool submit "$OUT" --keychain-profile <profile> --wait
  unzip -o "$OUT" -d /tmp && xcrun stapler staple /tmp/VoiceNote.app
  # re-zip the stapled .app before distributing
EOF
fi
