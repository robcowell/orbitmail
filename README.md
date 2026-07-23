# Orbit Mail

A desktop email client for Linux, with the three-pane layout Apple Mail users
will recognise. It handles Gmail, Microsoft 365, and any IMAP or POP3 account.
Your mail is cached on your machine, so search is instant and you can read
offline. Optional AI features — off unless you add your own API key — summarise
messages and pull out what you still need to do.

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![Platform](https://img.shields.io/badge/platform-Linux-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

- [What you can do](#what-you-can-do)
- [Install](#install)
- [Using Orbit Mail](#using-orbit-mail)
- [Your mail and your data](#your-mail-and-your-data)
- [What it can't do yet](#what-it-cant-do-yet)
- [Troubleshooting](#troubleshooting)

## What you can do

### Read and organise

- **All your accounts in one place** — a unified inbox across every account, plus
  each account's own folders.
- **Conversations** — replies group into a single row; opening one shows the whole
  back-and-forth, including your own replies from Sent.
- **New mail arrives on its own** — no polling button to press; the app keeps in
  step with the server, including changes you make on your phone.
- **Select several at once** — shift-click a range or ctrl-click individual rows,
  then delete, archive or move the lot. After anything leaves the list you land
  on the next message down, so you can work straight through a folder.
- **Search** — instant across your cached mail, and scoped to **All / From / To /
  Subject / Body**. If nothing matches locally, one click searches the whole
  mailbox on the server and pulls older mail back in.
- **Attachments** — messages carrying them are flagged in the list; save one or
  all of them wherever you like.

### Write

- A separate compose window with a proper formatting toolbar — headings, bold and
  italic, colour, lists, links, quotes.
- Replies keep the original as a collapsible quote, so your own words stay at the
  top.
- Attach by clicking **Attach** or dragging files onto the window.
- **Ctrl+Enter** sends.

### Accounts

Gmail and Microsoft 365 sign in through your browser. Everything else is manual
IMAP or POP3 with SMTP, and the app can usually detect the server settings from
your address.

> Gmail and Microsoft sign-in need OAuth credentials you register yourself —
> about 15 minutes, once. No build of Orbit Mail contains any, which is what
> makes a package safe to pass on. See [INSTALL.md](INSTALL.md#register-an-oauth-app).

### Living on your desktop

Light and dark mode. Desktop notifications for new mail. Your unread count in the
window title and on a tray icon. Links open in your browser. It remembers where
you were — folder, message, window size — between runs.

### AI, if you want it (optional)

Off by default. Nothing is sent anywhere until you add an
[Anthropic API key](https://console.anthropic.com/) via the ✦ button.

- **Analyze** turns the open email into action items, open questions and key
  context — and knows the difference between what you owe someone and what you
  asked of them.
- **Draft reply** writes an editable reply grounded in the conversation, in your
  choice of tone, and opens it in the composer for you to check and send.
- **Tasks** sweeps a whole folder into one prioritised list, each task linking
  back to its email. Tick things off and they stay off. Re-running a sweep only
  looks at mail it has not seen before, so it does not spend tokens twice.

## Install

Linux only, for now. Install the `.deb` or run the AppImage:

```bash
sudo dpkg -i "Orbit Mail-"*.deb
```

Building your own copy takes about 15 minutes and needs no coding. Both routes,
plus the OAuth setup for Gmail and Microsoft, are in **[INSTALL.md](INSTALL.md)**.

## Using Orbit Mail

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `C` | Compose |
| `R` | Reply |
| `/` | Search |
| `Shift` / `Ctrl` + click | Select a range of rows, or add and remove single ones. Delete, Archive and Move then act on all of them |
| `Delete` / `Backspace` | Move to Trash (or delete for good, if already in Trash). You land on the next message down |
| `Ctrl` + `Enter` | Send, in the compose window |

### The toolbar

**Compose**, **Reply**, **Forward**, **Delete**, **Archive**, **Star**,
**Mark unread**, **Refresh**. Plus, if you have added an API key, **Tasks** and
**AI settings** (✦).

### Folders and accounts

Click a folder to read it; unread counts show as badges. Right-click a folder for
mailbox actions — new mailbox, export, mark all read. The gear beside an account
name offers **Sync now** and **Remove account**.

## Your mail and your data

Everything Orbit Mail knows lives on your machine:

| Where | What |
|-------|------|
| `~/.config/orbit-mail/data/orbit-mail.db` | Your accounts, folders, cached mail and settings |
| `~/.config/orbit-mail/data/attachments/` | Downloaded attachments |

- **Nothing is sent anywhere except your mail servers** — no telemetry, no
  analytics, no accounts with us. There is no "us".
- **Only your account can read it.** The database and downloaded attachments are
  created readable by you alone, and an older install with looser permissions is
  corrected the next time the app starts — it matters on a machine with more than
  one user account.
- **Passwords and tokens are encrypted** using your system keyring. Without a
  keyring installed they fall back to obfuscation, and the app tells you so with a
  banner rather than pretending otherwise.
- **Remote images are blocked** until you ask for them, because loading them tells
  the sender you read the mail and reveals your IP address. You can allow them per
  message, or always for a particular sender.
- **Messages can't reach out of the reader.** Email HTML is stripped of anything
  that could run code or navigate the app before it is shown, and the same
  cleaning applies to text you quote in a reply.
- **Attachments that could execute** — `.desktop`, `.sh`, `.exe` and the like —
  ask before opening, and name the real file extension, because the point of a
  `document.pdf.exe` is that your eye stops reading at `.pdf`.
- **Outgoing attachments are limited to files you chose** in the file dialog or
  dragged in, so nothing can quietly attach something else from your disk.
- **AI is opt-in and per-message.** When you run Analyze, Draft reply or Tasks,
  the relevant message text goes to Anthropic's API to produce that result;
  results are cached locally so the same message is not sent twice. Your API key
  is stored encrypted and goes nowhere but Anthropic. Email text is fenced off in
  the prompt and the model is told to ignore instructions inside it — but that is
  a mitigation, not a guarantee, so read a draft before you send it, as you would
  anything a model wrote.
- **Removing an account removes its data** — cached mail, attachments, saved
  tasks and stored credentials.

## What it can't do yet

- **Gmail and Microsoft need your own OAuth app** — by design; see
  [INSTALL.md](INSTALL.md#register-an-oauth-app).
- **No signatures or inline images** when composing.
- **No draft autosave** — the Drafts folder syncs from the server, but a message
  in progress isn't saved until you send it.
- **POP3 is inbox-only** — no moving or archiving on the server.
- **First sync fetches the most recent 200 messages per folder.** Use **Load
  more** for older mail, or **Search whole mailbox** to pull in older matches.
- **Linux only** — no Windows or macOS builds.

The full backlog, including known bugs, is in [TODO.md](TODO.md).

## Troubleshooting

**Gmail sign-in fails**  
Check IMAP is enabled in your Gmail settings, and that you ticked the permission
box on the consent screen — Google leaves it unticked, and without it the app
cannot read your mail. See [INSTALL.md](INSTALL.md#two-google-screens-that-are-easy-to-get-wrong).

**Microsoft sign-in fails**  
Your organisation may block OAuth access to IMAP and SMTP; that setting is your
administrator's.

**Sync errors in the status bar**  
Click **Retry**, or **Re-authenticate** if it is an account problem.

**Unread counts look wrong**  
Click **Refresh**, or **Sync now** on the account. Note the window title counts
every account while a folder badge counts one folder, so those two differ
normally.

**A number on the taskbar icon that doesn't match**  
It is probably not Orbit Mail's. On Cinnamon, the number on a panel icon is the
desktop's own notification badge — pending notifications, not unread mail. Orbit
Mail's count is the tray icon and the window title.

**"… is already added as Gmail. Remove that account first"**  
An address can only be set up one way at a time. Adding it again the same way
updates it, which is how you re-authenticate or change a password; switching
between browser sign-in and manual IMAP would throw away the stored credentials.
Remove the account first if that is what you want.

**A message won't open**  
The reader says why and offers **Try again**. If it keeps failing, **Refresh** to
re-sync the folder.

**Links don't open**  
Orbit Mail hands links to your default browser — check you have one set.

## More

- **[INSTALL.md](INSTALL.md)** — installing, building your own copy, OAuth setup
- **[DEVELOPERS.md](DEVELOPERS.md)** — architecture, security posture, packaging,
  contributing
- **[TODO.md](TODO.md)** — backlog, known bugs, and decisions taken

## License

MIT
