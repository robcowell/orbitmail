# Orbit Mail

A desktop email client for Linux with an Apple Mail–inspired three-pane layout. Orbit Mail supports Gmail and Microsoft 365, plus manual IMAP, POP3, and SMTP accounts. Mail is cached locally for fast search and offline reading.

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![Platform](https://img.shields.io/badge/platform-Linux-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

## Features

### Mail

- **Multi-account inbox** — unified “All Inboxes” view plus per-account folders
- **Folder navigation** — Inbox, Sent, Drafts, Trash, Junk, and custom IMAP folders
- **Incremental sync** — only new messages are downloaded after the initial sync
- **Near-realtime updates** — background sync plus IMAP IDLE on inbox folders
- **Read, compose, reply, and forward** — separate compose window with threading headers on reply
- **Move and archive** — delete moves to Trash; archive moves to All Mail / Archive when available
- **Star and mark unread** — synced to the server
- **Attachments** — view incoming attachments; attach files when sending
- **Full-text search** — search subject, snippet, and body text locally
- **Load more** — paginated message lists for older mail

### Accounts

- **Gmail** — sign in with Google
- **Microsoft 365 / Outlook** — sign in with Microsoft
- **Other providers** — manual IMAP or POP3 + SMTP with optional server autodetect

### UX

- Light and dark mode
- Desktop notifications for new mail
- `mailto:` link handler — opens compose from other apps and browsers
- Persistent UI state — selected folder/message, collapsed accounts, dark mode, window size
- Offline-friendly — cached mail remains readable; status bar shows offline state
- Sync error recovery — retry and re-authenticate actions in the status bar
- External link handling — links in HTML messages open in your default browser

## Install

Orbit Mail is currently distributed for **Linux** only.

### Debian package

```bash
sudo dpkg -i release/Orbit\ Mail-*.deb
```

### AppImage

Download the AppImage from the release assets, make it executable, and run it:

```bash
chmod +x Orbit\ Mail-*.AppImage
./Orbit\ Mail-*.AppImage
```

Packaged builds register as a `mailto:` handler and install a desktop launcher for correct taskbar/window grouping on Cinnamon and other desktops.

> **Note:** Gmail and Microsoft sign-in require OAuth credentials to be configured at build time. Pre-built packages from the project maintainer include these; if you build from source yourself, see [DEVELOPERS.md](DEVELOPERS.md).

## Getting started

1. Launch Orbit Mail from your app menu or the AppImage.
2. Click **Add Account** and choose Gmail, Microsoft 365, or Other (IMAP / POP3).
3. Sign in or enter your server settings.
4. Select a folder in the sidebar — **All Inboxes** shows unread mail across accounts.

### Add a Gmail or Microsoft account

Choose the provider in the add-account wizard and complete sign-in in your browser. If sign-in fails, see [Troubleshooting](#troubleshooting).

### Add another provider (IMAP / POP3)

1. Click **Add Account → Other (IMAP / POP3)**
2. Enter email, username, and password
3. Optionally click **Autodetect** to fill server settings
4. Adjust incoming (IMAP or POP3) and outgoing (SMTP) settings if needed
5. The app verifies the connection before saving

Credentials are stored encrypted using your OS keychain.

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

### Sidebar and folders

- Click a folder to read its messages; unread counts appear as badges.
- Right-click a folder for mailbox actions (new mailbox, export, mark all read, sync account, and more).
- Click the gear icon next to an account name for **Sync now** and **Remove account**.

### Compose window

- Separate window with To, Cc, Bcc, subject, and body fields
- **Attach** — pick one or more files to send
- Window closes automatically after a successful send
- Supports `mailto:` links (e.g. from a browser or another app)

## Data & privacy

All local data is stored under the Electron user data directory:

| Path | Contents |
|------|----------|
| `~/.config/orbit-mail/data/orbit-mail.db` | SQLite database (accounts, folders, messages, preferences) |
| `~/.config/orbit-mail/data/attachments/` | Downloaded attachment files |

- Mail is synced over IMAP/POP3 and cached locally for performance and search
- OAuth tokens and passwords are stored in an encrypted blob per account
- No telemetry or third-party analytics are included

Removing an account from the sidebar deletes its local cached mail for that account.

## Known limitations

See [`TODO.md`](TODO.md) for the full backlog. Notable items at v0.1.0:

- **Gmail / Microsoft sign-in on self-built copies** — you must configure OAuth credentials when building from source; see [DEVELOPERS.md](DEVELOPERS.md)
- **POP3** — inbox sync only; move/archive are not supported on the server
- **Initial sync depth** — first sync fetches up to 200 messages per folder; use **Load more** for older mail
- **Compose** — plain-text body editor (HTML is generated as simple paragraphs)
- **No local draft autosave** — Drafts folder syncs from the server only
- **Linux only** — no Windows or macOS builds yet

## Troubleshooting

**Account add fails (Google)**  
Confirm IMAP is enabled in your Gmail settings. If you built the app yourself, check the OAuth setup in [DEVELOPERS.md](DEVELOPERS.md). If the app is in Google “Testing” mode, your account must be on the developer’s test-users list.

**Account add fails (Microsoft)**  
Try again after confirming your organisation allows OAuth IMAP/SMTP. If you built the app yourself, see the Microsoft OAuth section in [DEVELOPERS.md](DEVELOPERS.md).

**Sync errors in the status bar**  
Click **Retry**. For auth-related errors, use **Re-authenticate** to open the add-account wizard.

**Inbox badge and message list out of sync**  
Click **Refresh** in the toolbar or **Sync now** on the account. If it persists, restart the app.

**Links in messages do not open**  
Orbit Mail opens links in your default browser; check that a default browser is set in your desktop environment.

## Building from source

For development, OAuth setup, architecture, and packaging instructions, see **[DEVELOPERS.md](DEVELOPERS.md)**.

## License

MIT
