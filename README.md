# Orbit Mail

Apple Mail-style email client for Linux Mint Cinnamon. Supports Gmail and Microsoft 365 over IMAP and SMTP with OAuth 2.0 authentication.

## Features

- Three-pane layout inspired by Apple Mail
- Multi-account support (Gmail + Microsoft 365)
- Unified inbox across accounts
- Folder navigation (Inbox, Sent, Drafts, Trash, Junk)
- Read, compose, reply, forward
- Attachment viewing
- Full-text search (local SQLite FTS5)
- Background IMAP sync every 60 seconds

## Prerequisites

- Node.js 20+ (you have v24 via nvm)
- Linux Mint Cinnamon (or any Linux desktop)
- OAuth credentials from Google Cloud and Microsoft Entra ID

## OAuth Setup

### Google (Gmail)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project and enable the Gmail API
3. Create OAuth credentials → **Desktop app**
4. Copy Client ID and Client Secret

### Microsoft (Office 365)

1. Go to [Microsoft Entra admin center](https://portal.azure.com/)
2. Register a new application
3. Add platform: **Mobile and desktop applications**
4. Add redirect URI: `http://localhost`
5. Under API permissions, add delegated permissions:
   - `IMAP.AccessAsUser.All`
   - `SMTP.Send`
   - `openid`, `profile`, `email`, `offline_access`
6. Copy Application (client) ID

### Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
MICROSOFT_CLIENT_ID=your-microsoft-client-id
MICROSOFT_TENANT_ID=common
```

## Development

```bash
source ~/.nvm/nvm.sh
cd ~/code/orbit-mail
npm install
npm run dev
```

## Build for Linux Mint

```bash
npm run dist          # deb + AppImage
npm run dist:deb      # .deb only
npm run dist:appimage # AppImage only
```

Install the `.deb` package:

```bash
sudo dpkg -i release/Orbit\ Mail-*.deb
```

Or run the AppImage directly.

## Desktop Integration

The app registers with `StartupWMClass=orbit-mail` for Cinnamon window matching. Data is stored in `~/.config/orbit-mail/`.

## Account Requirements

- **Gmail:** IMAP must be enabled in Gmail settings. OAuth consent screen must include the `https://mail.google.com/` scope.
- **Microsoft 365:** IMAP/SMTP must be enabled by your tenant admin. Some organizations disable basic auth and require OAuth (supported).

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `C` | Compose new message |
| `R` | Reply to selected message |
| `/` | Focus search |
| `Delete` | Delete selected message |

## Architecture

- **Electron** main process handles IMAP/SMTP, OAuth, and SQLite
- **React** renderer for the UI
- **imapflow** for IMAP sync
- **nodemailer** for SMTP send
- **better-sqlite3** + Drizzle for local cache and FTS search

## License

MIT
