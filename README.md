# Orbit Mail

A desktop email client for Linux, with the three-pane layout Apple Mail users
will recognise. It handles Gmail, Microsoft 365, and any IMAP or POP3 account.

Deleting, archiving or moving a conversation can be undone from the message
that confirms it, and a message you have just sent can be taken back for ten
seconds. A conversation you cannot deal with now can be snoozed until later —
it moves to a Snoozed folder, so it leaves your inbox on your phone too, and
comes back when you asked for it (as long as Orbit is running). A message can
also be written now and sent later; it waits in Drafts until then, and opening
it there takes it back out of the queue.

Your mail is cached on your machine, so search is instant, across one account
or all of them at once, and you can read offline. When it can't reach a mail
server it says so, per account, rather than showing you old mail as though it
were current.

Optional AI features summarise messages and pull out what you still need to do.
They are off unless you add your own API key.

![Version](https://img.shields.io/badge/version-0.8.0-blue)
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
  all of them wherever you like. Images that are part of the message itself —
  the logos in people's signatures — are not listed as attachments, because a
  long reply chain collects a fresh copy of every one of them and they bury the
  files someone actually sent. They are still there: the message shows a count
  you can click to see them, and each can be opened or saved as usual. The
  paperclip in the list, and **Save all**, both go by real attachments only.
- **Gmail labels** — an open conversation shows the labels it carries, under the
  subject. Click the **×** on one to take it off, or **Label** to search your
  labels and tick them on and off; a name you have not used yet can be created
  from the same box. Labels apply to the whole conversation, and a label that
  only some of its messages carry is shown as such rather than pretended
  otherwise. Removing the **Inbox** label archives the conversation, as it does
  in Gmail — the button says so before you click it. Other kinds of account do
  not have labels, and do not show the row.

### Write

- A separate compose window with a proper formatting toolbar — headings, bold and
  italic, colour, lists, links, quotes.
- Replies keep the original as a collapsible quote, so your own words stay at the
  top. Expand it to **edit or trim** it down to the part you are answering, or
  **Remove** it entirely.
- **Reply**, **Reply All** and **Forward** sit on the message itself, above the
  email you are reading. Forwarding brings the original's attachments with it; if
  one cannot be fetched, the composer tells you which rather than sending an
  incomplete forward quietly. **Forward as Attachment** (Message menu, or
  right-click) sends the whole original untouched instead.
- **Drafts save themselves as you type**, so losing power or closing by accident
  does not lose what you wrote. Closing the window asks whether to keep it;
  sending just closes it, because the message has gone.
  Drafts live in **Drafts** in the sidebar: click one to read it, double-click
  (or **Continue editing**) to carry on, **Discard** or press Delete to throw it
  away. Sending removes it. An empty composer is not saved, so changing your
  mind leaves nothing behind. Drafts stay on this computer; they do not appear
  in webmail or on your phone.
- **Signatures**, per account, set in Settings → Accounts. They can be formatted
  and can include a pasted logo, and are added to the end of what you write —
  above the quoted text on a reply. Changing the From account swaps the signature
  for that account's, leaving what you have written alone.
- **Paste or drop an image straight into the message** and it appears where your
  cursor is. Images are sent inside the message so they show up in the
  recipient's client rather than arriving as a download. Anything over 5MB is
  refused — attach it instead.
- Attach by clicking **Attach** or dragging files onto the window.
- **Ctrl+Enter** sends.
- **To, Cc and Bcc autocomplete** from the people that account has actually
  corresponded with — no address book to maintain, and it works on the mail you
  already have. Anyone you have written to is offered before anyone who merely
  wrote to you, so a newsletter never sits above a colleague. Arrow keys to move,
  Enter or Tab to accept, Esc to dismiss.

### Accounts

Gmail and Microsoft 365 sign in through your browser. Everything else is manual
IMAP or POP3 with SMTP, and the app can usually detect the server settings from
your address.

> Gmail and Microsoft sign-in need OAuth credentials you register yourself —
> about 15 minutes, once. No build of Orbit Mail contains any, which is what
> makes a package safe to pass on. See [INSTALL.md](INSTALL.md#register-an-oauth-app).

### Living on your desktop

Light and dark mode, and a zoom for when the text is too small — `Ctrl` and
`+` or `-`, `Ctrl` `0` to reset, exactly as in a browser. It applies to every
window and is remembered between runs. Desktop notifications for new mail. Your unread count in the
window title and on a tray icon. Links open in your browser. It remembers where
you were — folder, message, window size — between runs.

Closing the window tucks Orbit Mail into the tray and keeps your mail syncing in
the background — the way most mail clients behave. Quitting for real is a
deliberate choice: the tray icon's **Quit**, or **File → Quit** (Ctrl+Q). (If
your desktop doesn't draw a tray icon, launching Orbit Mail again brings the
hidden window back.)

### AI, if you want it (optional)

Off by default. Nothing is sent anywhere until you add an
[Anthropic API key](https://console.anthropic.com/) via the ✦ button.

- **Analyze** turns the open email into a plain-language account of what it
  says, plus action items, open questions and key context. Every action names
  who owes it — yours are marked and listed first, so you can see at a glance
  what is on you and what you are waiting on someone else for. It knows the
  difference between what you owe someone and what you asked of them.
  If the email has attachments you can include them, and it will read Word,
  Excel, PowerPoint and OpenDocument files, RTF, PDFs, images, calendar
  invitations, plain text, and an email forwarded to you as an attachment.
  Older formats (`.doc`, `.xls`), Apple iWork files and password-protected
  documents it cannot read — it names those under the summary rather than
  quietly leaving them out. If you analyse without attachments, it says so and
  offers to include them, so a summary written from the covering note alone
  never passes for one that read the document. Settings → AI has an **Always
  include attachments** switch if you would rather it never asked.
  Summaries come in **Full** or **Brief** — set it in Settings → AI. Brief is a
  sentence or two and only what you need to act on, which also costs less per
  message.
- **Summarize** turns a long conversation into what it is about, what was
  decided, what is still outstanding and who owes it, and what nobody has
  answered. It reads the mail already on this computer, and says so when a
  thread is longer than it can take in or has moved on since.
- **Draft reply** writes an editable reply grounded in the conversation, in your
  choice of tone, and opens it in the composer for you to check and send. Choose
  **Reply** or **Reply All** in the same menu — that sets the recipients *and*
  tells the draft whether it is writing to one person or to the whole thread.
- **Tasks** sweeps a whole folder into one prioritised list, each task linking
  back to its email. Tick things off and they stay off. Re-running a sweep only
  looks at mail it has not seen before, so it does not spend tokens twice —
  **Re-analyze all** is there for when you do want the whole folder read again,
  and says so before it spends anything. You can print the list for an account,
  or export it to a Markdown file.

## Install

Linux only, for now. Install the `.deb` or run the AppImage:

```bash
sudo dpkg -i orbit-mail-*.deb
```

Building your own copy takes about 15 minutes and needs no coding. Both routes,
plus the OAuth setup for Gmail and Microsoft, are in **[INSTALL.md](INSTALL.md)**.

## Using Orbit Mail

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `C` | Compose |
| `R` | Reply — to the open conversation's latest message, or the selected one |
| `F` | Forward, the same message `R` would reply to |
| `/` | Search |
| `Shift` / `Ctrl` + click | Select a range of rows, or add and remove single ones. Delete, Archive and Move then act on all of them |
| `Delete` / `Backspace` | Move to Trash (or delete for good, if already in Trash). You land on the next message down |
| `Ctrl` + `Enter` | Send, in the compose window |
| `Ctrl` + `,` | Settings |
| `Ctrl` + `+` / `-` | Make everything bigger or smaller, as in a browser |
| `Ctrl` + `0` | Back to normal size |

### The toolbar

**Compose**, **Delete**, **Archive**, **Star**, **Mark unread**, **Refresh**,
and **Settings** (the gear). Plus, if you have added an API key, **Tasks** and
**AI settings** (✦).

Replying and forwarding are not up here — they act on one message, so they live
on the message you are reading, along with **Draft reply**, **Analyze**, **Add to
tasks** and **Print**.

### Settings

The gear, or `Ctrl` + `,`. What you can change today:

- **Appearance** — dark mode, and whether mail is grouped into conversations.
- **When you close the window** — keep running in the tray, or quit. (If your
  desktop has no tray, this says so instead of offering a switch that would do
  nothing.)
- **Notifications** — on or off. The unread count and tray icon keep updating
  either way.
- **Default mail app** — open `mailto:` links in Orbit Mail. This registers with
  your desktop, so it needs an installed copy rather than a development build,
  and the switch reflects what actually took effect.
- **Privacy** — the senders you have blocked or muted, with a button to undo
  either, and whether remote images load everywhere or only for senders you have
  allowed.
- **Accounts** — rename an account, choose how much mail to keep on this
  computer, see what it is using, sync it, or remove it. Removing tells you how
  many messages and how much disk space go with it; your mail on the server is
  untouched. For IMAP and POP3 accounts you can also change the server, port,
  security and password, with a **Test connection** button — settings that do
  not work are not saved. Changing the address itself means removing the account
  and adding it again.
- **AI** — your Anthropic API key, which Claude model the AI features use, how
  long it may think before answering, how much the summaries say (**Full** or
  **Brief**), and whether attachments are always included without asking. All three cost you more or less per message on your Anthropic
  bill — a more capable model, a higher effort, and a fuller summary each add to
  it. A change applies to the next thing you ask for; results already saved are
  kept.

The gear beside an account in the sidebar, and right-clicking a folder, both
open this screen on that account.

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
| `~/.config/orbit-mail/renderer-errors.log` | Written only if the window fails to draw — what went wrong, so a report has something to attach |

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
  the relevant message text goes to Anthropic's API to produce that result. If
  you choose **Include attachments**, the text of those attachments goes too —
  extracted on this computer, so the files themselves are never uploaded;
  results are cached locally so the same message is not sent twice. Your API key
  is stored encrypted and goes nowhere but Anthropic. Email text is fenced off in
  the prompt and the model is told to ignore instructions inside it — but that is
  a mitigation, not a guarantee, so read a draft before you send it, as you would
  anything a model wrote.
- **Addresses for autocomplete are collected on your machine** from the mail an
  account has sent and received, and are never uploaded or shared between
  accounts — composing from your work address only suggests people that account
  knows. There is currently no way to edit or delete a single collected address;
  removing the account clears all of them.
- **Blocking a sender hides their mail, it does not delete it.** Blocked mail
  disappears from your lists, searches and unread counts, and stays on your mail
  server; unblocking in Settings → Privacy brings it straight back. Muting is
  gentler still — the mail arrives and is listed as normal, it just never
  interrupts you with a notification.
- **Removing an account removes its data** — cached mail, attachments, saved
  tasks, collected addresses and stored credentials.

## What it can't do yet

- **Gmail and Microsoft need your own OAuth app** — by design; see
  [INSTALL.md](INSTALL.md#register-an-oauth-app).
- **Drafts stay on this computer** — they are saved as you type, but not uploaded
  to the account's Drafts folder, so one started here will not appear in webmail
  or on your phone.
- **POP3 is inbox-only** — no moving or archiving on the server.
- **Labels can be put on the conversation you are reading, not on a selection** —
  and labels themselves can be created but not renamed or deleted from here.
- **First sync fetches the most recent 200 messages per folder.** Use **Load
  more** for older mail, or **Search whole mailbox** to pull in older matches.
- **A very long conversation is capped at 200 messages** — you see the most
  recent 200, and the app does not currently tell you when there were more.
- **Linux only** — no Windows or macOS builds.

The full backlog, including known bugs, is in [TODO.md](TODO.md).

## Troubleshooting

**Gmail sign-in fails**  
Check IMAP is enabled in your Gmail settings, and that you ticked the permission
box on the consent screen — Google leaves it unticked, and without it the app
cannot read your mail. See [INSTALL.md](INSTALL.md#two-google-screens-that-are-easy-to-get-wrong).

**"… signs in with Google, but there is no Gmail mailbox behind it"**  
The Google sign-in worked; the address just doesn't receive its mail at Gmail.
That happens when a Google Account was created using an address from somewhere
else — a work or hosting-provider mailbox — or when Gmail is switched off for a
Workspace user. Add it again with **Other (IMAP / POP3)** instead, using the
incoming and outgoing server settings from whoever hosts mail for the domain.

**Microsoft sign-in fails**  
Your organisation may block OAuth access to IMAP and SMTP; that setting is your
administrator's.

**Adding an IMAP account fails**  
The message names which of the two servers refused and what it said. "Rejected
the username and password" usually means the username should be your full email
address, and the password the mailbox one rather than the one for your host's
website. "Presented a certificate that does not cover that name" means the
server name is wrong — **Autodetect** guesses `imap.yourdomain` and
`smtp.yourdomain` when it can't find real settings, and on shared hosting those
names often belong to the hosting company instead. Use the exact server names
your provider documents.

**The window has gone blank**  
Click **Reload** on the panel that appears. If the window is blank with no
panel, close and reopen Orbit Mail — your mail is stored on this computer, so
nothing is lost either way. It writes what happened to `renderer-errors.log` in
your settings folder (`~/.config/orbit-mail/`), which is the useful thing to
attach if you report it.

**A message says "Not sent"**  
A send is held for a few seconds so you can take it back, so it goes out after
the compose window has closed — which means a failure appears as a message in the
main window rather than in the composer. It says which server refused and why,
and the message stays in Drafts, so you can fix the problem and send it again.
"The server refused this address" is usually a typo in a recipient.

**Sync errors in the status bar**  
The status bar names the account and the reason. "Rejected the login" means the
password stopped working — most often because it was changed with your provider;
update it in Settings → Accounts. Otherwise click **Retry**, or
**Re-authenticate** if it is an account problem.

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
