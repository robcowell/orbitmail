# Orbit Mail

A desktop email client for Linux with an Apple Mail–inspired three-pane layout. Orbit Mail supports Gmail and Microsoft 365, plus manual IMAP, POP3, and SMTP accounts. Mail is cached locally for fast search and offline reading. Optional, bring-your-own-key AI features can summarise messages and surface outstanding tasks.

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
- Unread count badge on the taskbar / launcher and in the window title
- `mailto:` link handler — opens compose when enabled in preferences (not registered as the system default automatically)
- Persistent UI state — selected folder/message, collapsed accounts, dark mode, window size
- Offline-friendly — cached mail remains readable; status bar shows offline state
- Sync error recovery — retry and re-authenticate actions in the status bar
- External link handling — links in HTML messages open in your default browser

### AI (optional)

Bring your own [Anthropic API key](https://console.anthropic.com/) to unlock optional AI features — **off by default**; nothing is sent anywhere until you add a key via the ✦ button in the toolbar (**AI settings**).

- **Analyze** — the **Analyze** button in the message header turns the open email into action items, open questions, and key context, with sender awareness (what *you* need to do vs. what you asked of others). Results are cached per message.
- **Tasks sweep** — the checklist button sweeps the current folder's unread mail into one prioritised, source-linked task list, so you can triage a whole inbox at once.

Your API key is stored encrypted on your device — see [Data & privacy](#data--privacy).

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

Packaged builds install a `.desktop` launcher with `StartupWMClass=orbit-mail` for correct taskbar/window grouping on Cinnamon and other desktops. They can handle `mailto:` links when you opt in via system default applications or `window.orbitMail.preferences.setHandleMailtoLinks(true)`.

> **Note:** Gmail and Microsoft sign-in require OAuth credentials to be configured at build time. Pre-built packages from the project maintainer include these; to run your own copy with your own credentials, see [Run your own copy](#run-your-own-copy) below.

## Run your own copy

Orbit Mail doesn't ship with its own Gmail/Microsoft sign-in credentials — you supply your own ([why](DEVELOPERS.md#oauth-setup)). Running your own copy takes about 15 minutes and a terminal, but no coding. You only need to set up the provider(s) you actually use — skip the OAuth steps entirely if you only use plain IMAP/POP3.

**1. Install the prerequisites** (Debian / Ubuntu / Mint):

```bash
sudo apt install git nodejs npm build-essential python3
```

Node.js 20 or newer is required — check with `node --version`. If your distro ships an older Node, install a current one from [nodejs.org](https://nodejs.org/) or via `nvm`.

**2. Get the code and install dependencies:**

```bash
git clone <your-repo-url> orbit-mail
cd orbit-mail
npm install
```

**3. Register your own OAuth app** (only needed for Gmail / Microsoft accounts). The developer guide walks each click:

- **Gmail** → [Google OAuth setup](DEVELOPERS.md#google-gmail): create a Google Cloud project, enable the Gmail API, set the consent screen to **External** and **Publish** it, create a **Desktop app** credential, and copy the Client ID + Secret.
- **Microsoft 365 / Outlook** → [Microsoft OAuth setup](DEVELOPERS.md#microsoft-office-365--outlook): register an app in Entra, add the `http://127.0.0.1/callback` redirect, enable public client flows, and copy the Application (client) ID.

**4. Add your credentials:**

```bash
cp .env.example .env
```

Open `.env` in a text editor and paste in the values from step 3. Leave blank any provider you don't use.

**5. Run it** — either in dev mode:

```bash
npm run dev
```

…or build an installable package and install it:

```bash
npm run dist
sudo dpkg -i "release/Orbit Mail-"*.deb
```

**6. Add your account:** click **Add Account**, choose your provider, and sign in. For Gmail (or any unverified app), you'll hit a **"Google hasn't verified this app"** screen — click **Advanced → Go to Orbit Mail (unsafe)** and continue. That's expected for a self-run copy, and it appears only once per account.

> Rebuild after editing `.env` — OAuth credentials are baked in at build time.

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
| `Delete` / `Backspace` | Move selected message to Trash (or delete permanently if already in Trash) |

### Toolbar actions

- **Compose** — open a new message window
- **Reply / Forward** — opens compose with quoted content and reply threading headers
- **Delete** — move to Trash (or permanent delete from Trash)
- **Archive** — move to Archive / All Mail folder when one exists for the account
- **Star** — toggle flagged state on the server
- **Mark unread** — mark the selected message as unread
- **Refresh** — trigger a manual sync
- **Tasks** — sweep the current folder's unread mail for outstanding tasks (requires an Anthropic API key)
- **AI settings** (✦) — add or remove your Anthropic API key

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
- **AI is opt-in.** Nothing is sent to any AI provider unless you add an Anthropic API key. When you run **Analyze** or **Tasks**, the relevant message text is sent to Anthropic's API to produce the result. Your API key is stored encrypted (Electron `safeStorage`) in the local database and never leaves your device except to authenticate with Anthropic.
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
- **AI features are optional and BYO-key** — require your own Anthropic API key; when used, message text is sent to Anthropic (see [Data & privacy](#data--privacy))

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
