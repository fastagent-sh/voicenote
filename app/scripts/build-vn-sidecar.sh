#!/usr/bin/env bash
set -euo pipefail

# Stage everything the bundled .app needs as Tauri externalBin / resources.
#
#   build-vn-sidecar.sh            # host arch (for `tauri dev`)
#   build-vn-sidecar.sh universal  # fat x86_64+arm64 (for the shipped build)
#
# Executables (vn/bun/ffprobe) are externalBin named with the build's target
# triple so Tauri picks them up. pi is JS (arch-independent) → a plain resource.

MODE="${1:-host}"
HERE="$(cd "$(dirname "$0")" && pwd)"   # app/scripts
APP="$(dirname "$HERE")"                # app
REPO="$(dirname "$APP")"                # repo root
RES="$APP/src-tauri/binaries"
RESOURCES="$APP/src-tauri/resources"
CACHE="$APP/.build-cache"
mkdir -p "$RES" "$RESOURCES"

# Everything the app ships is pinned here (pi comes from package.json, which the
# CLI package installs too). A build either produces exactly these versions or
# fails; nothing is picked up from whatever the build machine happens to have.
BUN_VERSION="1.3.14"
FFPROBE_VERSION="2.1.2"          # @ffprobe-installer/ffprobe (host arch)
FFPROBE_ARM64_VERSION="5.0.1"    # @ffprobe-installer/darwin-arm64
FFPROBE_X64_VERSION="5.1.0"      # @ffprobe-installer/darwin-x64

# `bun build --compile` embeds the compiling bun's runtime, so the build host's
# bun has to be the pinned one / the shipped vn would differ per machine.
HOST_BUN_VERSION="$(bun --version)"
if [ "$HOST_BUN_VERSION" != "$BUN_VERSION" ]; then
  echo "ERROR: this build requires bun $BUN_VERSION, found $HOST_BUN_VERSION." >&2
  echo "       Install it with: curl -fsSL https://bun.sh/install | bash -s bun-v$BUN_VERSION" >&2
  exit 1
fi

cd "$REPO"
[ -d node_modules/cac ] || bun install   # vn deps (cac)

# ── pi package (JS, same for both arches) ──
# Staged at the version pinned in the repo's package.json, never from the build
# machine's global install, so every build ships the same pi as the CLI package.
# Installed with npm (not bun): pi ships an npm-shrinkwrap, and npm reproduces
# the self-contained nested node_modules tree that resources/pi needs.
stage_pi() {
  PI_VERSION="$(node -p "require('$REPO/package.json').dependencies['@earendil-works/pi-coding-agent']")"
  STAGED_VERSION="$(node -p "try{require('$RESOURCES/pi/package.json').version}catch(e){''}")"
  if [ "$STAGED_VERSION" = "$PI_VERSION" ]; then
    echo "✓ pi: resources/pi ($PI_VERSION, already staged)"
    return
  fi
  PI_TMP="$(mktemp -d)"
  npm install --prefix "$PI_TMP" --no-save --no-audit --no-fund "@earendil-works/pi-coding-agent@$PI_VERSION" >/dev/null
  rm -rf "$RESOURCES/pi"; mkdir -p "$RESOURCES/pi"
  cp -R "$PI_TMP/node_modules/@earendil-works/pi-coding-agent/." "$RESOURCES/pi/"
  rm -rf "$PI_TMP"
  echo "✓ pi: resources/pi ($PI_VERSION, $(du -sh "$RESOURCES/pi" | cut -f1))"
}

if [ "$MODE" = "universal" ]; then
  # Tauri's `--target universal-apple-darwin` builds each arch slice and lipos
  # them itself, so we provide BOTH per-arch sidecars (not a pre-merged one).
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

  # Tauri needs the per-arch sidecars (build phase) AND a merged -universal one
  # (bundle phase), so we produce all three for each binary.

  # vn: cross-compile each arch, then lipo
  bun build --compile --target=bun-darwin-arm64 src/cli.ts --outfile "$RES/vn-aarch64-apple-darwin"
  bun build --compile --target=bun-darwin-x64   src/cli.ts --outfile "$RES/vn-x86_64-apple-darwin"
  lipo -create "$RES/vn-aarch64-apple-darwin" "$RES/vn-x86_64-apple-darwin" -output "$RES/vn-universal-apple-darwin"
  echo "✓ vn: aarch64 + x86_64 + universal"

  # bun runtime: download each arch from GitHub releases
  BASE="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION"
  curl -fsSL "$BASE/bun-darwin-aarch64.zip" -o "$TMP/bun-arm.zip"
  curl -fsSL "$BASE/bun-darwin-x64.zip"     -o "$TMP/bun-x64.zip"
  ditto -x -k "$TMP/bun-arm.zip" "$TMP/bun-arm"
  ditto -x -k "$TMP/bun-x64.zip" "$TMP/bun-x64"
  cp -f "$(find "$TMP/bun-arm" -name bun -type f | head -1)" "$RES/bun-aarch64-apple-darwin"
  cp -f "$(find "$TMP/bun-x64" -name bun -type f | head -1)" "$RES/bun-x86_64-apple-darwin"
  lipo -create "$RES/bun-aarch64-apple-darwin" "$RES/bun-x86_64-apple-darwin" -output "$RES/bun-universal-apple-darwin"
  chmod +x "$RES/bun-aarch64-apple-darwin" "$RES/bun-x86_64-apple-darwin" "$RES/bun-universal-apple-darwin"
  echo "✓ bun: aarch64 + x86_64 + universal ($BUN_VERSION)"

  # ffprobe: `npm pack` each per-arch package (tarball download skips the host
  # platform check that `npm install` enforces)
  mkdir -p "$TMP/fp-arm" "$TMP/fp-x64"
  ( cd "$TMP/fp-arm" && npm pack "@ffprobe-installer/darwin-arm64@$FFPROBE_ARM64_VERSION" >/dev/null 2>&1 && tar -xzf ./*.tgz )
  ( cd "$TMP/fp-x64" && npm pack "@ffprobe-installer/darwin-x64@$FFPROBE_X64_VERSION" >/dev/null 2>&1 && tar -xzf ./*.tgz )
  cp -f "$(find "$TMP/fp-arm" -name ffprobe -type f | head -1)" "$RES/ffprobe-aarch64-apple-darwin"
  cp -f "$(find "$TMP/fp-x64" -name ffprobe -type f | head -1)" "$RES/ffprobe-x86_64-apple-darwin"
  lipo -create "$RES/ffprobe-aarch64-apple-darwin" "$RES/ffprobe-x86_64-apple-darwin" -output "$RES/ffprobe-universal-apple-darwin"
  chmod +x "$RES/ffprobe-aarch64-apple-darwin" "$RES/ffprobe-x86_64-apple-darwin" "$RES/ffprobe-universal-apple-darwin"
  echo "✓ ffprobe: aarch64 + x86_64 + universal ($FFPROBE_ARM64_VERSION/$FFPROBE_X64_VERSION)"

else
  SUF="$(rustc -vV | sed -n 's/host: //p')"

  bun build --compile src/cli.ts --outfile "$RES/vn-$SUF"
  echo "✓ vn: binaries/vn-$SUF"

  cp -f "$(realpath "$(command -v bun)")" "$RES/bun-$SUF"; chmod +x "$RES/bun-$SUF"
  echo "✓ bun: binaries/bun-$SUF ($BUN_VERSION)"

  # Cache keyed by version: a pin bump re-downloads, a plain rebuild does not.
  CACHED_FFPROBE="$CACHE/ffprobe-$FFPROBE_VERSION-$SUF"
  if [ ! -f "$CACHED_FFPROBE" ]; then
    STAGE="$(mktemp -d)"
    ( cd "$STAGE" && npm install --no-save --no-package-lock --no-audit --no-fund "@ffprobe-installer/ffprobe@$FFPROBE_VERSION" >/dev/null 2>&1 )
    mkdir -p "$CACHE"
    cp -f "$(cd "$STAGE" && node -e 'console.log(require("@ffprobe-installer/ffprobe").path)')" "$CACHED_FFPROBE"
    rm -rf "$STAGE"
  fi
  cp -f "$CACHED_FFPROBE" "$RES/ffprobe-$SUF"; chmod +x "$RES/ffprobe-$SUF"
  echo "✓ ffprobe: binaries/ffprobe-$SUF ($FFPROBE_VERSION)"
fi

stage_pi
