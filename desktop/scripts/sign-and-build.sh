#!/usr/bin/env bash
set -euo pipefail

# Builds and signs a release locally, using the certificate created by
# create-signing-cert.sh. CI does the same through .github/workflows.
#
#   bash scripts/sign-and-build.sh ./signing/VoiceNoteSigning.p12 <password>

P12="${1:?usage: sign-and-build.sh <p12> <password>}"
PASSWORD="${2:?usage: sign-and-build.sh <p12> <password>}"
KEYCHAIN="${TMPDIR:-/tmp}/voicenote-build.keychain"

security delete-keychain "$KEYCHAIN" 2>/dev/null || true
security create-keychain -p "$PASSWORD" "$KEYCHAIN"
security unlock-keychain -p "$PASSWORD" "$KEYCHAIN"
security import "$P12" -k "$KEYCHAIN" -P "$PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
# Without this, codesign fails with errSecInternalComponent: the key exists but
# no tool is allowed to use it without a UI prompt.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PASSWORD" "$KEYCHAIN" >/dev/null

cd "$(dirname "$0")/.."
npm run build
VN_SIGN_IDENTITY="VoiceNote Self Signed" VN_SIGN_KEYCHAIN="$KEYCHAIN" npx electron-builder --mac --arm64 "${@:3}"
