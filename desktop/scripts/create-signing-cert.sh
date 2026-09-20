#!/usr/bin/env bash
set -euo pipefail

# Creates the code-signing certificate the app is signed with.
#
# Why a self-signed certificate and not "no signature": macOS refuses to
# *install* an update to an app it cannot verify — Squirrel.Mac checks that the
# downloaded app satisfies the running app's designated requirement, and an
# unsigned build fails with "code has no resources but signature indicates they
# must be present". A self-signed certificate satisfies that check as long as
# every release is signed with the SAME certificate.
#
# What it does not buy: Gatekeeper still does not know this certificate, so the
# first launch needs右键 → 打开. A paid Developer ID would remove that step.
#
#   KEEP THE .p12 AND ITS PASSWORD. Signing a future release with a different
#   certificate breaks auto-update for everyone already on the old one: they
#   have to download the new version by hand.
#
# Usage: bash scripts/create-signing-cert.sh out-dir password

OUT="${1:-./signing}"
PASSWORD="${2:?usage: create-signing-cert.sh <out-dir> <p12-password>}"
mkdir -p "$OUT"

cat > "$OUT/cert.conf" <<'CONF'
[ req ]
default_bits = 2048
prompt = no
distinguished_name = dn
x509_extensions = v3
[ dn ]
CN = VoiceNote Self Signed
O = fastagent-sh
[ v3 ]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CONF

openssl req -x509 -newkey rsa:2048 -keyout "$OUT/key.pem" -out "$OUT/cert.pem" \
  -days 3650 -nodes -config "$OUT/cert.conf"
# -legacy: macOS's keychain cannot import the AES-256 PKCS#12 OpenSSL 3 writes
# by default.
openssl pkcs12 -export -legacy -inkey "$OUT/key.pem" -in "$OUT/cert.pem" \
  -out "$OUT/VoiceNoteSigning.p12" -passout "pass:$PASSWORD" -name "VoiceNote Self Signed"

echo
echo "Created $OUT/VoiceNoteSigning.p12"
echo "For CI, store it as a secret:  base64 -i $OUT/VoiceNoteSigning.p12 | pbcopy"
