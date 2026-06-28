#!/usr/bin/env bash
set -euo pipefail

# Ensures the Electron binary is present (fixes partial installs / extract-zip failures).
unset ELECTRON_RUN_AS_NODE

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON_DIR="$ROOT/node_modules/electron"
VERSION="$(node -p "require('$ELECTRON_DIR/package.json').version")"
DIST="$ELECTRON_DIR/dist"
PATH_FILE="$ELECTRON_DIR/path.txt"
PLATFORM_PATH="electron"

if [[ -x "$DIST/$PLATFORM_PATH" ]] && [[ -f "$PATH_FILE" ]]; then
  echo "Electron $VERSION already installed."
  exit 0
fi

echo "Installing Electron $VERSION binary..."

rm -rf "$DIST"
mkdir -p "$DIST"

CACHE_ZIP=$(find "${HOME}/.cache/electron" -name "electron-v${VERSION}-linux-x64.zip" 2>/dev/null | head -1)

if [[ -z "$CACHE_ZIP" ]]; then
  node "$ELECTRON_DIR/install.js"
else
  unzip -q -o "$CACHE_ZIP" -d "$DIST"
fi

printf '%s' "$PLATFORM_PATH" > "$PATH_FILE"

if [[ ! -x "$DIST/$PLATFORM_PATH" ]]; then
  echo "Electron binary missing after install." >&2
  exit 1
fi

echo "Electron $VERSION ready at $DIST/$PLATFORM_PATH"
