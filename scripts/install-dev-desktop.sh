#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON="$ROOT/build/icons/256x256.png"
DESKTOP_FILE="$DESKTOP_DIR/orbit-mail.desktop"

if [[ ! -f "$ICON" ]]; then
  echo "Icons not found. Run: npm run icons" >&2
  exit 1
fi

mkdir -p "$DESKTOP_DIR"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Name=Orbit Mail
GenericName=Email Client
Comment=Desktop email client for Linux (development)
Exec=env -C "$ROOT" npm run dev
Path=$ROOT
Icon=$ICON
Terminal=false
Type=Application
Categories=Network;Email;
Keywords=email;mail;inbox;imap;smtp;
StartupNotify=true
StartupWMClass=orbit-mail
MimeType=x-scheme-handler/mailto;
EOF

chmod 644 "$DESKTOP_FILE"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

echo "Installed launcher: $DESKTOP_FILE"
