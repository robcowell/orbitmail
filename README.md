# Orbit Mail

A desktop email client for Linux with an Apple Mail–inspired three-pane layout. Orbit Mail supports Gmail and Microsoft 365, plus manual IMAP, POP3, and SMTP accounts. Mail is cached locally for fast search and offline reading. Optional, bring-your-own-key AI features can summarise messages and surface outstanding tasks.

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![Platform](https://img.shields.io/badge/platform-Linux-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

## Features

### Mail

- **Multi-account inbox** — unified “All Inboxes” view plus per-account folders
- **Conversation threading** — messages group into one row per conversation; opening a thread shows the full back-and-forth across folders, with your Sent replies interleaved
- **Folder navigation** — Inbox, Sent, Drafts, Trash, Junk, and custom IMAP folders
- **Incremental sync** — only new messages are downloaded after the initial sync
- **Near-realtime updates** — background sync plus IMAP IDLE on inbox folders, with live flag changes and server-side deletions (EXPUNGE) pushed and reconciled
- **Read, compose, reply, and forward** — separate compose window with threading headers on reply
- **Move and archive** — delete moves to Trash; archive moves to All Mail / Archive when available. Anything that takes a message out of the list moves you on to the next one down, so you can work through a folder without re-picking a row
- **Star and mark unread** — synced to the server
- **Attachments** — view incoming attachments (rows carrying attachments are flagged with a paperclip in the list); attach files when sending
- **Scoped search** — search across **All / From / To / Subject / Body** with a one-click clear, matched instantly against locally cached mail; your last-used scope is remembered
- **Whole-mailbox search** — when local results come up empty (or on demand via **Search whole mailbox**), Orbit Mail runs a live search on the server to reach mail older than the sync window, importing matches so they open like any cached message (IMAP accounts only)
- **Load more** — paginated message lists for older mail

### Accounts

- **Gmail** — sign in with Google
- **Microsoft 365 / Outlook** — sign in with Microsoft
- **Other providers** — manual IMAP or POP3 + SMTP with optional server autodetect

### UX

- Light and dark mode
- Snappy UI — optimistic read/star/flag/move actions, an instantly-painting reader, and a virtualized message list that stays smooth on large folders
- Desktop notifications for new mail — showing the receiving account, sender name, and subject (truncated to fit)
- Unread count in three places: the window title, a **system tray icon** that shows the number on the icon itself (up to 9+, with the exact figure in its tooltip), and the taskbar / launcher on desktops implementing the Unity `LauncherEntry` API (Unity, KDE, GNOME with Dash-to-Dock). **Cinnamon ignores that last one** — its window-list applet has no support for those signals — which is why the tray icon exists
- `mailto:` link handler — opens compose when enabled in preferences (not registered as the system default automatically)
- Persistent UI state — selected folder/message, collapsed accounts, dark mode, window size
- Offline-friendly — cached mail remains readable; status bar shows offline state
- Sync error recovery — retry and re-authenticate actions in the status bar
- External link handling — links in HTML messages open in your default browser

### AI (optional)

Bring your own [Anthropic API key](https://console.anthropic.com/) to unlock optional AI features — **off by default**; nothing is sent anywhere until you add a key via the ✦ button in the toolbar (**AI settings**).

- **Analyze** — the **Analyze** button in the message header turns the open email into action items, open questions, and key context, with sender awareness (what *you* need to do vs. what you asked of others). Results are cached per message. On messages with attachments you can choose to **include the attachments** for extra context — it prompts first, since that uses more tokens.
- **Draft reply** — the **Draft reply** button generates an editable reply grounded in the whole conversation, in your choice of tone (**Brief / Neutral / Detailed**), and opens it in the composer with the quoted original kept collapsible.
- **Tasks sweep** — the checklist button opens a task list built from the current folder, so you can triage a whole inbox at once. Each task is prioritised and links back to its source email.
  - **Unread (default) or All messages** — choose which mail a sweep scans from the toggle in the dialog.
  - **Tick tasks done** — completed tasks are kept in a persistent history, and the model is told not to raise them again on later sweeps.
  - **Persisted & incremental** — sweep results are saved per folder, so reopening the dialog costs nothing. A sweep only sends messages it hasn't analysed before, so re-sweeping an unchanged inbox spends no tokens; only newly arrived mail is billed.
  - **Export to Markdown** — save the current task list (grouped by priority, with the completed history) to a `.md` file on demand.

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

> **Note:** Gmail and Microsoft sign-in need OAuth credentials, and Orbit Mail never ships any — a build must be safe to hand to someone else, so no package contains its builder's credentials. You register an OAuth app once and give Orbit Mail the details **when you add an account**, or put them in `~/.config/orbit-mail/.env`. Plain IMAP/POP3 accounts need none of this. See [Run your own copy](#run-your-own-copy).

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

**6. Add your account:** click **Add Account**, choose your provider, and sign in. If Orbit Mail has no credentials for that provider yet, it asks for them first and stores them encrypted on this machine.

For Gmail you will meet two screens that are easy to get wrong:

- **"Google hasn't verified this app"** — click **Advanced → Go to Orbit Mail (unsafe)**. Expected for a self-run copy; once per account.
- **The permissions screen** — tick **"Read, compose, send and permanently delete all your email from Gmail"**. Google leaves this box **unticked by default**, and without it sign-in completes but Orbit Mail cannot read your mail, so it will refuse the account and tell you to try again.

> No rebuild is needed after changing credentials. They are read at runtime, so editing `.env` (or `~/.config/orbit-mail/.env`) and restarting is enough — and you can skip the file entirely by entering them in the Add Account dialog.

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
| `Shift`/`Ctrl` + click | Select a range of rows, or add/remove one — in both the flat list and conversation view. Delete, Archive and Move act on the whole selection |
| `Delete` / `Backspace` | Move selected message to Trash (or delete permanently if already in Trash); selection moves to the next message down, so you can keep deleting |

### Toolbar actions

- **Compose** — open a new message window
- **Reply / Forward** — opens compose with quoted content and reply threading headers
- **Delete** — move to Trash (or permanent delete from Trash)
- **Archive** — move to Archive / All Mail folder when one exists for the account
- **Star** — toggle flagged state on the server
- **Mark unread** — mark the selected message as unread
- **Refresh** — trigger a manual sync
- **Tasks** — open the task list for the current folder and sweep its unread or all mail for outstanding tasks (requires an Anthropic API key)
- **AI settings** (✦) — add or remove your Anthropic API key

### Sidebar and folders

- Click a folder to read its messages; unread counts appear as badges.
- Right-click a folder for mailbox actions (new mailbox, export, mark all read, sync account, and more).
- Click the gear icon next to an account name for **Sync now** and **Remove account**.

### Compose window

- Separate window with To, Cc, Bcc, subject, and body fields
- **Rich text editor** — a formatting toolbar with headings, bold/italic/underline/strikethrough, text alignment, text colour, bulleted and numbered lists, links, block quotes, inline code, and clear-formatting. Messages are sent as HTML (with a plain-text alternative).
- **Quoted replies** — on a reply or forward, the earlier message appears as a collapsible **quoted text** block (collapsed by default) below a separator, with an attribution line, so your new text stays front and centre.
- **Attach** — click **Attach** or **drag files onto the window**; each attachment shows a type icon and its size, and can be removed individually
- **⌘↵ / Ctrl+↵** sends the message; the window closes automatically after a successful send
- Supports `mailto:` links (e.g. from a browser or another app)

## Data & privacy

All local data is stored under the Electron user data directory:

| Path | Contents |
|------|----------|
| `~/.config/orbit-mail/data/orbit-mail.db` | SQLite database (accounts, folders, messages, preferences, saved AI tasks) |
| `~/.config/orbit-mail/data/attachments/` | Downloaded attachment files |

- Mail is synced over IMAP/POP3 and cached locally for performance and search
- OAuth tokens and passwords are stored in an encrypted blob per account (Electron `safeStorage`; without a system keyring this degrades to obfuscation)
- **No build ever contains OAuth credentials** — yours or anyone's. They are supplied on the machine that runs the app, so a package is safe to pass on
- **AI is opt-in.** Nothing is sent to any AI provider unless you add an Anthropic API key. When you run **Analyze** or **Tasks**, the relevant message text is sent to Anthropic's API to produce the result. Analyze results and per-message task extractions are cached locally so the same message is not re-sent on a later run. Your API key is stored encrypted (Electron `safeStorage`) in the local database and never leaves your device except to authenticate with Anthropic.
- No telemetry or third-party analytics are included

**How mail is rendered.** Message HTML comes from whoever sent it, so it is sanitized before display: scripts, forms, frames and embedded objects are removed, and CSS that would let a message paint over the app is stripped. **Remote images are blocked by default** — a message's external images and CSS backgrounds are not fetched until you ask, because loading them confirms you read the mail and reveals your IP to the sender. A bar above the message offers **Load images** (just this message) or **Always load from _sender_** (remembered per sender); embedded and inline images still show. When you reply or forward, the quoted original is sanitized the same way, so the sender's trackers and remote images are not carried into your message or your Sent folder. The window itself cannot be navigated away from the app, and a Content-Security-Policy backs both. Links open in your browser, not in Orbit Mail. Attachments whose type can execute — `.desktop`, `.sh`, `.exe` and similar — ask for confirmation before opening, naming the real file extension. In the other direction, a message can only carry files **you** chose: outgoing attachments are limited to what you picked in the file dialog or dragged into the compose window, so a flaw in message rendering could not quietly attach a file from your disk and send it.

Removing an account deletes all of its local data — cached mail and message bodies, downloaded attachment files, its saved AI Tasks, and its stored credentials. When the app has closed, if the database has accumulated a lot of freed space it is compacted (`VACUUM`) to return it to the disk.

## Known limitations

See [`TODO.md`](TODO.md) for the full backlog. Notable items at v0.1.0:

- **Gmail / Microsoft sign-in needs your own OAuth app** — no build of Orbit Mail contains credentials, by design. Register once and enter the details when adding an account (about 15 minutes); see [DEVELOPERS.md](DEVELOPERS.md#oauth-setup)
- **Remote images are blocked by default** — external images and CSS backgrounds are not loaded until you choose **Load images** for that message or **Always load from _sender_**. There is no global "always load everything" setting yet; the per-sender allow is the escape hatch
- **Credential encryption needs a keyring** — without one (`safeStorage` unavailable), stored passwords, tokens and API keys fall back to obfuscation rather than encryption. The app warns you when this is the case (a banner at the top of the window); install a keyring such as gnome-keyring or kwallet to enable encryption at rest
- **POP3** — inbox sync only; move/archive are not supported on the server
- **Initial sync depth** — first sync fetches up to 200 messages per folder; use **Load more** for older mail, or **Search whole mailbox** to pull in older matches on demand (IMAP accounts)
- **Compose** — rich text (HTML) editor; no signatures or inline images yet
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

**A number on the taskbar icon that does not match the unread count**  
Check what is drawing it before assuming it is Orbit Mail's. The window title
carries the total across all accounts, while a folder's badge counts only that
folder — 6 in an inbox and 9 in the title is normal with several accounts. On
Cinnamon the number on the panel icon is usually the desktop's own *notification*
badge (Menu → Preferences → Applets → Grouped window list → "Show notification
badges"), which counts pending notifications, not mail; Cinnamon ignores the
launcher-count signal entirely.

**"… is already added as Gmail. Remove that account first"**  
An address can only be set up one way at a time. Adding it again with the same
method updates it (that is how you re-authenticate or change a password), but
switching between OAuth and manual IMAP/POP3 would replace the stored
credentials — an OAuth sign-in cannot be recovered afterwards — and change how
the mail already synced for it is treated. Remove the account first if that is
what you want; removing it also clears its cached mail.

**A message or conversation will not open**  
The reader says why and offers **Try again** — the fetch is a local call to the
app's own database, so a failure usually means a sync is mid-write or the
message has since been removed on the server. If retrying keeps failing, hit
**Refresh** to re-sync the folder.

**Links in messages do not open**  
Orbit Mail opens links in your default browser; check that a default browser is set in your desktop environment.

## Building from source

For development, OAuth setup, architecture, and packaging instructions, see **[DEVELOPERS.md](DEVELOPERS.md)**.

## License

MIT
