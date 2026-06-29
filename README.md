# Orbit Mail

A desktop email client for Linux with an Apple Mail–inspired three-pane layout. Orbit Mail supports Gmail and Microsoft 365 via OAuth, plus manual IMAP, POP3, and SMTP accounts. Mail is cached locally in SQLite for fast search and offline reading.

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![Platform](https://img.shields.io/badge/platform-Linux-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

## Features

### Mail

- **Multi-account inbox** — unified “All Inboxes” view plus per-account folders
- **Folder navigation** — Inbox, Sent, Drafts, Trash, Junk, and custom IMAP folders
- **Incremental sync** — UID-based fetching; only new messages are downloaded after initial sync
- **Near-realtime updates** — background poll every 20 seconds plus IMAP IDLE on inbox folders
- **Read, compose, reply, and forward** — separate compose window with threading headers on reply
- **Move and archive** — delete moves to Trash; archive moves to All Mail / Archive when available
- **Star and mark unread** — synced to the server via IMAP flags
- **Attachments** — view incoming attachments; attach files when sending
- **Full-text search** — local SQLite FTS5 index across subject, snippet, and body text
- **Load more** — paginated message lists (200 messages per page)

### Accounts

- **Gmail** — OAuth 2.0 (Google Cloud desktop app)
- **Microsoft 365 / Outlook** — OAuth 2.0 (Microsoft Entra ID)
- **Other providers** — manual IMAP or POP3 + SMTP with optional server autodetect (Mozilla ISPDB + domain fallbacks)

### UX

- Light and dark mode
- Desktop notifications for new mail
- `mailto:` link handler — opens compose from other apps and browsers
- Persistent UI state — selected folder/message, collapsed accounts, dark mode, window size
- Offline-friendly — cached mail remains readable; status bar shows offline state
- Sync error recovery — retry and re-authenticate actions in the status bar
- External link handling — links in HTML messages open in your default browser

## Requirements

- **Node.js** 20 or later
- **Linux** desktop (developed on Linux Mint Cinnamon; other desktops supported)
- **OAuth credentials** — required for Gmail and Microsoft 365 during development (see below)
- **Build tools** — needed for `better-sqlite3` native module (`build-essential`, Python, etc.)

## Quick Start

```bash
git clone <your-repo-url> orbit-mail
cd orbit-mail
npm install
cp .env.example .env
# Edit .env with your OAuth client IDs (for Gmail/O365)
npm run dev
```

If Electron fails to start because `ELECTRON_RUN_AS_NODE` is set in your shell:

```bash
unset ELECTRON_RUN_AS_NODE
npm run dev
```

### Add a launcher to your app menu (development)

Generates a `.desktop` file that runs `npm run dev` from the project directory:

```bash
npm run icons
npm run install:desktop
```

## OAuth Setup

OAuth client IDs are loaded from a `.env` file at dev/build time. End users of packaged builds will need registered app credentials until in-app OAuth configuration is added (see [Known Limitations](#known-limitations)).

```bash
cp .env.example .env
```

### Google (Gmail)

1. Open [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project and enable the **Gmail API**
3. Configure the OAuth consent screen (External; add test users while in Testing mode)
4. Create credentials → **Desktop app**
5. Add the `https://mail.google.com/` scope to the consent screen
6. Copy the Client ID and Client Secret into `.env`:

```env
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
```

**Gmail notes**

- IMAP must be enabled in Gmail settings
- While the app is in Google OAuth Testing mode, each Gmail account must be added as a test user

### Microsoft (Office 365 / Outlook)

1. Open [Microsoft Entra admin center](https://portal.azure.com/) → **App registrations** → **New registration**
2. Set **Supported account types** to match the accounts you'll sign in with (e.g. _Accounts in any organizational directory and personal Microsoft accounts_ for both work and outlook.com)
3. Under **Authentication** → **Add a platform** → **Mobile and desktop applications**
4. Add the loopback redirect URI **exactly**: `http://127.0.0.1/callback`
   - Entra ignores the port for loopback URIs, so this single entry covers the random port Orbit Mail listens on. The host (`127.0.0.1`) and path (`/callback`) must match.
5. Under **Authentication** → **Advanced settings**, set **Allow public client flows** to **Yes** (required for the desktop sign-in + refresh-token flow)
6. Copy the **Application (client) ID** into `.env`:

```env
MICROSOFT_CLIENT_ID=your-microsoft-client-id
MICROSOFT_TENANT_ID=common
```

**Microsoft notes**

- **You do not need to add API permissions in the portal.** Orbit Mail requests the IMAP/SMTP scopes (`IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`) dynamically at sign-in, and you consent in the browser. This is why "Office 365 Exchange Online" not appearing under **API permissions → APIs my organization uses** does not matter for this flow.
- That API only appears for tenants with an active Exchange Online license; for personal Microsoft accounts it is absent by design. If your tenant admin requires _pre-consent_, you can add it by searching the GUID `00000002-0000-0ff1-ce00-000000000000`, but it is optional here.
- Your tenant administrator must allow OAuth-based IMAP/SMTP (some tenants disable IMAP/SMTP entirely).
- `MICROSOFT_TENANT_ID=common` works for most cases; use your specific tenant GUID to restrict sign-in to one organization.

### Manual IMAP / POP3 accounts

No OAuth setup required. In the app:

1. Click **Add Account → Other (IMAP / POP3)**
2. Enter email, username, and password
3. Optionally click **Autodetect** to fill server settings from Mozilla’s ISPDB
4. Adjust incoming (IMAP or POP3) and outgoing (SMTP) server settings if needed
5. The app verifies the connection before saving

Credentials are stored encrypted using the OS keychain via Electron `safeStorage` (with a base64 fallback if encryption is unavailable).

## Usage

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `C` | Compose new message |
| `R` | Reply to selected message |
| `/` | Focus search |
| `Delete` | Move selected message to Trash (or delete permanently if already in Trash) |

### Toolbar actions

- **Compose** — open a new message window
- **Reply / Forward** — opens compose with quoted content and reply threading headers
- **Delete** — move to Trash (or permanent delete from Trash)
- **Archive** — move to Archive / All Mail folder when one exists for the account
- **Star** — toggle flagged state on the server
- **Mark unread** — mark the selected message as unread
- **Refresh** — trigger a manual sync

### Account management

Click the gear icon next to an account name in the sidebar:

- **Sync now** — refresh that account immediately
- **Remove account** — delete the account and its local cached data

### Compose window

- Separate window with To, Cc, Bcc, subject, and body fields
- **Attach** — pick one or more files to send
- Window closes automatically after a successful send
- Supports `mailto:` links (e.g. from a browser or another app)

## Building & Installing

Regenerate icons before building distributables:

```bash
npm run icons
```

### Build from source

```bash
npm run build
```

Output goes to `out/` (main, preload, and renderer bundles).

### Linux packages

```bash
npm run dist          # .deb + AppImage
npm run dist:deb      # .deb only
npm run dist:appimage # AppImage only
```

Install the Debian package:

```bash
sudo dpkg -i release/Orbit\ Mail-*.deb
```

Or run the AppImage directly from `release/`.

Packaged builds register as a `mailto:` handler and install a `.desktop` launcher with `StartupWMClass=orbit-mail` for correct taskbar/window grouping on Cinnamon and other desktops.

## Data & Privacy

All local data is stored under the Electron user data directory:

| Path | Contents |
|------|----------|
| `~/.config/orbit-mail/data/orbit-mail.db` | SQLite database (accounts, folders, messages, preferences) |
| `~/.config/orbit-mail/data/attachments/` | Downloaded attachment files |

On other platforms the base path follows Electron conventions (`app.getPath('userData')`).

- Mail is synced over IMAP/POP3 and cached locally for performance and search
- OAuth tokens and passwords are stored in an encrypted blob per account
- No telemetry or third-party analytics are included

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Renderer (React + Zustand)                             │
│  Three-pane UI · Compose · Search · Preferences         │
└───────────────────────────┬─────────────────────────────┘
                            │ typed IPC (contextBridge)
┌───────────────────────────▼─────────────────────────────┐
│  Main process (Electron)                                │
│  IMAP sync · SMTP send · OAuth · IDLE · Notifications   │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│  SQLite (better-sqlite3 + Drizzle) + FTS5               │
└─────────────────────────────────────────────────────────┘
```

| Layer | Technology |
|-------|------------|
| Shell | Electron 34, electron-vite |
| UI | React 18, TypeScript, Zustand, Phosphor Icons |
| IMAP | imapflow (sync, IDLE, move, flags) |
| POP3 | node-pop3 (inbox-only sync) |
| SMTP | nodemailer |
| Parsing | mailparser |
| OAuth | google-auth-library, @azure/msal-node |
| Storage | better-sqlite3, Drizzle ORM, FTS5 |
| HTML sanitization | DOMPurify |

### Project layout

```
orbit-mail/
├── electron/           # Main process: sync, OAuth, DB, IPC
│   ├── main.ts
│   ├── preload.ts
│   ├── db/             # Schema, migrations, FTS
│   └── services/       # imap-sync, smtp-send, oauth-*, etc.
├── src/                # Renderer: React UI
├── shared/             # Types shared between main and renderer
├── build/              # Icons and .desktop template
├── scripts/            # Icon generation, dev launcher install
└── release/            # electron-builder output (after dist)
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Build main, preload, and renderer for production |
| `npm run preview` | Preview production build |
| `npm run icons` | Regenerate PNG icons from `build/icon.svg` |
| `npm run install:desktop` | Install a dev `.desktop` launcher |
| `npm run dist` | Build icons, compile, and package (.deb + AppImage) |
| `npm run dist:deb` | Debian package only |
| `npm run dist:appimage` | AppImage only |

## Known Limitations

See [`TODO.md`](TODO.md) for the full backlog. Notable items at v0.1.0:

- **OAuth for packaged builds** — users currently need developer-supplied client IDs in `.env`; no in-app OAuth settings yet
- **POP3** — inbox sync only; move/archive not supported on server
- **Initial sync depth** — first sync fetches up to 200 messages per folder; use **Load more** for older mail
- **Compose** — plain-text body editor (HTML is generated as simple paragraphs)
- **No local draft autosave** — Drafts folder syncs from the server only
- **Linux only** — no Windows or macOS builds yet

## Troubleshooting

**Account add fails (Google)**  
Confirm IMAP is enabled, the consent screen includes `https://mail.google.com/`, and your account is a test user if the app is in Testing mode.

**Account add fails (Microsoft)**  
Register the redirect URI exactly as `http://127.0.0.1/callback`, set **Allow public client flows** to **Yes**, and confirm your tenant allows OAuth IMAP/SMTP. You do **not** need to add "Office 365 Exchange Online" API permissions — scopes are consented in the browser at sign-in. If you see "no refresh token", re-check that public client flows are enabled and try again.

**Sync errors in the status bar**  
Click **Retry**. For auth-related errors, use **Re-authenticate** to open the add-account wizard.

**App icon missing in dev launcher**  
Run `npm run icons` before `npm run install:desktop`.

**`better-sqlite3` compile errors on install**  
Install build essentials: `sudo apt install build-essential python3`.

## License

MIT
