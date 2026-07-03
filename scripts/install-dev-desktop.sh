#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_THEME_BASE="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
DESKTOP_FILE="$DESKTOP_DIR/orbit-mail.desktop"

echo "Regenerating icons from build/icon.svg…"
npm run icons --prefix "$ROOT"

if [[ ! -f "$ROOT/build/icons/256x256.png" ]]; then
  echo "Icons not found after generation." >&2
  exit 1
fi

echo "Installing icons into $ICON_THEME_BASE…"
for size in 16 32 48 64 128 256 512; do
  icon_dir="$ICON_THEME_BASE/${size}x${size}/apps"
  mkdir -p "$icon_dir"
  cp "$ROOT/build/icons/${size}x${size}.png" "$icon_dir/orbit-mail.png"
done

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$ICON_THEME_BASE" >/dev/null 2>&1 || true
fi

mkdir -p "$DESKTOP_DIR"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Name=Orbit Mail
GenericName=Email Client
Comment=Desktop email client for Linux (development)
Exec=env -C "$ROOT" npm run dev
Path=$ROOT
Icon=orbit-mail
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
echo "Icons installed as orbit-mail (run this script again after changing build/icon.svg)."
