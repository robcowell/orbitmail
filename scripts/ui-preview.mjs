// Serve the built renderer to an ordinary browser, with `window.orbitMail` stubbed.
//
//   npm run build && npm run ui:preview     # then open http://localhost:4321
//
// Why this exists: `npm run dev` cannot start here (GPU sandbox crash), so every
// UI change used to end with "someone please click through it". The renderer is
// a plain React app — the only reason it will not run outside Electron is that
// it errors on a missing IPC bridge. Stubbing that bridge is the same trick
// `scripts/store-race.mjs` uses to reach renderer logic under node; this does it
// in a real DOM so the result can be looked at, screenshotted, and driven by
// browser automation.
//
// WHAT THIS PROVES: layout, styling, both themes, whether a control renders and
// reacts, and that the renderer mounts without console errors.
//
// WHAT IT DOES NOT: anything main-process. Every IPC answer here is a fixture,
// so a pane can look perfect while the channel behind it is missing. The IPC
// contract check and the behaviour tests in `npm run test:imap` are what cover
// that, and neither is replaced by this.

import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER_DIR = process.env.RENDERER_DIR ?? join(REPO_ROOT, 'out', 'renderer')
const PORT = Number(process.env.PORT ?? 4321)

if (!existsSync(join(RENDERER_DIR, 'index.html'))) {
  console.error(`No built renderer at ${RENDERER_DIR} — run \`npm run build\` first.`)
  process.exit(1)
}

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

// The stub, as a source string — it is served as its own file rather than
// inlined because the production CSP is `script-src 'self'`.
//
// Fixtures are deliberately a little messy (two accounts, unread counts, a
// muted and a blocked sender, a swept task list): a pane that only ever renders
// empty state hides most of what is worth looking at.
const STUB = `
const accounts = [
  // Gmail, so the reader's label row is reachable at all — it renders nothing
  // for any other provider, where a folder is a place and not a label.
  { id: 'acc-1', email: 'you@example.com', displayName: 'Personal', provider: 'gmail', syncDays: 30, signature: '' },
  // Left as plain IMAP so the fixture holds one account of each kind: the label
  // row must be absent here and present on the Gmail one above.
  { id: 'acc-2', email: 'you@work.example', displayName: 'Work', provider: 'imap', syncDays: 90, signature: '' }
]
// The custom folders are listed out of alphabetical order on purpose: that is
// how a server hands its labels over, and the sidebar is supposed to sort them.
const folders = accounts.flatMap((a) => [
  { id: a.id + '-inbox', accountId: a.id, imapPath: 'INBOX', name: 'Inbox', type: 'inbox', unreadCount: 3, totalCount: 12 },
  { id: a.id + '-sent', accountId: a.id, imapPath: 'Sent', name: 'Sent', type: 'sent', unreadCount: 0, totalCount: 8 },
  { id: a.id + '-drafts', accountId: a.id, imapPath: 'Drafts', name: 'Drafts', type: 'drafts', unreadCount: 0, totalCount: 0 },
  // Two nested labels sharing a leaf name, which is what Gmail's hierarchy
  // makes easy to end up with: the name is the leaf, so the sidebar shows
  // "Receipts" twice and only the path tells them apart. (No backticks in
  // here — the whole stub is a template literal.)
  { id: a.id + '-l1', accountId: a.id, imapPath: 'Work/Receipts', name: 'Receipts', type: 'custom', unreadCount: 0, totalCount: 4 },
  { id: a.id + '-l5', accountId: a.id, imapPath: 'Home/Receipts', name: 'Receipts', type: 'custom', unreadCount: 1, totalCount: 3 },
  { id: a.id + '-l2', accountId: a.id, imapPath: 'accounts', name: 'accounts', type: 'custom', unreadCount: 2, totalCount: 9 },
  { id: a.id + '-l3', accountId: a.id, imapPath: 'Travel', name: 'Travel', type: 'custom', unreadCount: 0, totalCount: 1 },
  { id: a.id + '-l4', accountId: a.id, imapPath: 'Bills', name: 'Bills', type: 'custom', unreadCount: 0, totalCount: 6 }
])

// Sender HTML for the thread fixture. Written the way real mail is: a table
// wrapper with presentational attributes, and colours in inline style
// attributes, which is the only place they survive the sanitizer (it forbids
// <style>, so a head stylesheet never applies).
const BODY_HTML = [
  '<div style="color:#1a1a1a;font-family:Arial,sans-serif">' +
    '<p>Can we move the launch to the 14th? That gives the printers a week of slack.</p>' +
    '<p style="color:#333">Happy either way, but I would rather not cut it fine.</p>' +
    '<p><a href="https://example.com/schedule" style="color:#1155cc">The current schedule</a></p>' +
    '</div>',
  '<div><p>Works for me. I will let Priya know about the pricing page.</p>' +
    '<p><em>Sent from a device that sets no colours.</em></p></div>',
  '<table bgcolor="#ffffff" width="100%"><tr><td>' +
    '<p>Then the 14th it is — I will tell the printers.</p>' +
    '<p>Priya, does that still work for the pricing page copy?</p>' +
    '</td></tr></table>'
]

// Where a caller needs a particular shape. Anything not listed falls through to
// the generic rule below.
const OVERRIDES = {
  'accounts.list': accounts,
  // Must carry every field of AccountInfo. A fixture missing one does not
  // degrade — the pane throws on it (\`info.unreadCount.toLocaleString()\`), and
  // the crash looks exactly like an app bug until you read the stack. If a pane
  // blows up here, suspect the fixture before the component.
  'accounts.getInfo': {
    id: 'acc-1', provider: 'imap', providerLabel: 'IMAP',
    email: 'you@example.com', displayName: 'Personal',
    createdAt: Date.now() - 86400000 * 200,
    folderCount: 9, messageCount: 1284, unreadCount: 3,
    syncDays: 30, localStorageBytes: 41233920,
    attachmentCount: 212, downloadedAttachmentCount: 64,
    signature: ''
  },
  // ManualAccountSettings — nested \`incoming\`/\`outgoing\`, and note there is no
  // \`password\` field: main never sends one (see toManualSettings), so the
  // fixture must not invent one either.
  'accounts.getManualSettings': {
    email: 'you@example.com',
    displayName: 'Personal',
    username: 'you@example.com',
    incomingProtocol: 'imap',
    incoming: { host: 'imap.example.com', port: 993, security: 'ssl' },
    outgoing: { host: 'smtp.example.com', port: 465, security: 'ssl' },
    hasPassword: true
  },
  'folders.list': folders,
  // Two hits from two different accounts, so the unified search's folder
  // qualifier ("Inbox · Personal" vs "Inbox · Work") is actually visible. The
  // generic fallback below returns [] for anything starting with "search",
  // which would show the box working but prove nothing about the labels.
  'search.query': [
    {
      id: 'sr-1', folderId: 'acc-1-inbox', accountId: 'acc-1', uid: 90,
      messageId: '<sr1@example.com>', from: 'Jan <jan@work.example>',
      to: 'you@example.com', subject: 'Invoice for August',
      snippet: 'Attached is the invoice you asked about.',
      date: Date.now() - 7200000, isRead: true, isStarred: false,
      flagColor: null, hasAttachments: true, threadId: null
    },
    {
      id: 'sr-2', folderId: 'acc-2-inbox', accountId: 'acc-2', uid: 91,
      messageId: '<sr2@example.com>', from: 'Accounts <ap@supplier.example>',
      to: 'you@work.example', subject: 'Invoice reminder',
      snippet: 'A gentle nudge about invoice 4471.',
      date: Date.now() - 90000000, isRead: false, isStarred: false,
      flagColor: null, hasAttachments: false, threadId: null
    }
  ],
  'messages.deleteMany': { deleted: 2, failed: 0 },
  'messages.moveMany': { deleted: 2, failed: 0 },
  'messages.undoRelocate': { restored: 2, failed: 0 },
  'messages.list': [],
  'messages.count': 0,
  // One conversation, so the thread reader — and the conversation summary that
  // hangs off it — can actually be looked at. Every field of ThreadSummary and
  // MessageDetail must be present: a missing one throws inside the component
  // rather than degrading, and the stack reads exactly like an app bug.
  'messages.listThreads': [
    {
      threadId: 'thread-1', accountId: 'acc-1', latestMessageId: 'm3',
      from: 'Jan <jan@work.example>', subject: 'Q3 launch date',
      snippet: 'Then the 14th it is — I will tell the printers.',
      date: Date.now() - 3600000, isStarred: false, flagColor: null,
      hasAttachments: false, messageCount: 3, hasUnread: false,
      participants: ['Jan', 'You', 'Priya']
    }
  ],
  'messages.countThreads': 1,
  // The conversation's labels. One of them is on a single message of three,
  // because "partial" is a state the picker and the chip both render
  // differently and a fixture where every label were complete would look
  // identical with that distinction deleted.
  'messages.labels': [
    { folderId: 'acc-1-inbox', name: 'Inbox', imapPath: 'INBOX', isInbox: true, messageCount: 3 },
    { folderId: 'acc-1-l1', name: 'Receipts', imapPath: 'Work/Receipts', isInbox: false, messageCount: 3 },
    { folderId: 'acc-1-l3', name: 'Travel', imapPath: 'Travel', isInbox: false, messageCount: 1 }
  ],
  'messages.availableLabels': folders.filter(
    (f) => f.accountId === 'acc-1' && (f.type === 'inbox' || f.type === 'custom')
  ),
  // Nothing here talks to a server, so a click reports success and the row
  // re-reads the same fixture: the picker's layout and states are what can be
  // looked at here, not the effect of applying one.
  'messages.addLabel': { changed: 1, failed: 0 },
  'messages.removeLabel': { changed: 1, failed: 0 },
  'messages.getThread': ['m1', 'm2', 'm3'].map((id, i) => ({
    id, folderId: 'acc-1-inbox', accountId: 'acc-1', uid: 100 + i,
    messageId: '<' + id + '@work.example>', threadId: 'thread-1',
    from: i === 1 ? 'You <you@example.com>' : 'Jan <jan@work.example>',
    to: 'you@example.com', cc: '', references: null,
    subject: 'Q3 launch date',
    snippet: '…', date: Date.now() - (3 - i) * 3600000,
    isRead: true, isStarred: false, flagColor: null, hasAttachments: false,
    bodyText: 'Message ' + (i + 1) + ' of the conversation.',
    // All three carry HTML, because the dark-mode contrast bug only appears in
    // sender HTML and a null body can never show it. Each is one of the three
    // states worth looking at: message 1 sets dark text and no background (the
    // common case — the sender assumed a white page), message 3 sets a white
    // background and no text colour (the same bug from the other side: our own
    // light text lands on the sender's white table), and message 2 sets no
    // colour at all, so in dark mode it must stay dark like the app around it.
    bodyHtml: BODY_HTML[i],
    // The last message carries attachments, one of them a format the analysis
    // cannot read. That is what makes the split "Analyze" button (with its
    // "Include attachments" option) and the skipped-attachment caveat
    // reachable here at all — with no attachments anywhere, neither renders.
    //
    // The trailing image.png copies are inline: a signature logo repeated once
    // per reply. They are the case AttachmentList collapses, so the fixture
    // carries enough of them for the disclosure to be worth looking at.
    attachments: i === 2
      ? [
          { id: 'att-1', messageId: id, filename: 'Q3 launch plan.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            size: 38112, localPath: null, inline: false },
          { id: 'att-2', messageId: id, filename: 'Minutes 2019.doc',
            mimeType: 'application/msword', size: 21044, localPath: null, inline: false },
          { id: 'att-3', messageId: id, filename: 'Logo.png',
            mimeType: 'image/png', size: 8123, localPath: null, inline: false },
          // No backticks: this whole fixture lives inside the STUB template
          // literal, and one would close it.
          ...Array.from({ length: 12 }, (_, n) => ({
            id: 'att-inline-' + n, messageId: id, filename: 'image.png',
            mimeType: 'image/png', size: [583, 745, 8712][n % 3], localPath: null, inline: true
          }))
        ]
      : []
  })),
  // What an analysis that had to leave an attachment out looks like. The
  // caveat is the point of the fixture: a summary written without the plan
  // reads exactly like one written with it, so the panel has to name the file
  // the model never saw.
  'ai.analyze': {
    summary:
      'Jan has confirmed that the launch moves from the 7th to the 14th, giving the printers a week of slack before the deadline. She will tell them directly, so nothing is needed from you on that side. The open point is the pricing page: Priya asked whether the copy can be ready by the 14th, and nobody has answered her. The attached launch plan sets out the remaining milestones and assumes sign-off two days before launch, which the new date leaves intact.',
    // Mixed ownership on purpose: the user's own action must be findable
    // among other people's, which is the whole point of showing both.
    actionItems: [
      { owner: 'Jan', action: 'Tell the printers the launch has moved to the 14th' },
      { owner: 'You', action: 'Confirm the pricing page copy date with Priya' },
      { owner: 'Unassigned', action: 'Update the launch checklist with the new date' }
    ],
    questions: ['Is the pricing page copy ready by the 14th?'],
    keyContext: ['Launch date: the 14th', 'Printers get a week of slack'],
    generatedAt: Date.now(),
    cached: false,
    // Text-only, on a message carrying a readable .docx: the state the
    // "not included" caveat exists for. A fixture with this true would render
    // identically whether the caveat works or not.
    attachmentsIncluded: false
  },
  // A stored summary, so the panel renders without an API key. Shaped as
  // AiThreadAnalysis: the counts drive the "new messages since" note, so this
  // one is deliberately stale to show that state too.
  'ai.getCachedThreadAnalysis': {
    summary:
      'Jan proposed moving the launch to the 14th so the printers have a week of slack. You agreed, and Priya asked whether the pricing page copy can be ready by then.',
    decisions: ['Launch moves to the 14th', 'Printers get a week of slack'],
    // The user's item is deliberately *last* here: the panel must lift it to
    // the top, and a fixture that already has it first proves nothing.
    actionItems: [
      { owner: 'Jan', action: 'Tell the printers the new date' },
      { owner: 'Priya', action: 'Confirm whether the pricing page copy can be ready' },
      { owner: 'You', action: 'Confirm the pricing page copy date with Priya' }
    ],
    openQuestions: ['Is the pricing page copy ready by the 14th?'],
    generatedAt: Date.now() - 7200000,
    cached: true,
    messageCount: 2,
    analyzedCount: 2,
    currentMessageCount: 3,
    stale: true
  },
  // A single-message analysis that had to leave an attachment out. The caveat
  // is the whole point of the fixture: a summary written without the agenda
  // looks exactly like one written with it, so the panel has to say which
  // files the model never saw.
  'ai.getCachedAnalysis': {
    summary:
      'Jerry reminds club members that the Club Council meeting is at 6.30pm on Tuesday 4th August at the Burlington Hotel.',
    actionItems: [
      { owner: 'You', action: 'Attend the Club Council meeting at 6.30pm on Tuesday 4th August' }
    ],
    questions: [],
    keyContext: ['Meeting: Tuesday 4 August, 6.30pm, Burlington Hotel'],
    generatedAt: Date.now() - 600000,
    cached: true,
    attachmentsIncluded: true,
    skippedAttachments: ['Minutes 2019.doc']
  },
  // Sync status is per account. One mailbox is deliberately failing here so the
  // sidebar's health marker and the status bar's error line are both visible in
  // the preview — they are invisible in a fixture where everything is healthy.
  'sync.getStatus': {
    syncing: false,
    lastSyncAt: Date.now() - 120000,
    syncCurrent: 0,
    syncTotal: 0,
    accounts: {
      'acc-1': {
        accountId: 'acc-1', email: 'you@example.com',
        syncing: false, lastSyncAt: Date.now() - 120000, error: null,
        reachedServer: true
      },
      'acc-2': {
        accountId: 'acc-2', email: 'you@work.example',
        syncing: false, lastSyncAt: Date.now() - 5400000,
        error: 'Authentication failed: token expired',
        // Refused, not unreachable — which is why the offline banner stays
        // away here even though this account is failing.
        reachedServer: true
      }
    }
  },
  'ai.getStatus': { configured: true },
  'ai.getTasks': {
    tasks: [
      { id: 't1', task: 'Send the signed lease back to the letting agent', priority: 'urgent',
        sourceMessageId: 'm1', sourceSubject: 'Lease renewal — action needed',
        sourceFrom: 'Lettings <lettings@example.com>' },
      { id: 't2', task: 'Confirm numbers for the quiz night', priority: 'medium',
        sourceMessageId: 'm2', sourceSubject: 'Quiz night headcount',
        sourceFrom: 'Jan <jan@work.example>' }
    ],
    completed: [],
    analyzedCount: 34,
    scope: 'unread',
    sweptAt: Date.now() - 3600000
  },
  'app.getSecureStorageStatus': { available: true },
  'app.getPlatformCapabilities': { trayActive: true, notificationsSupported: true, mailtoHandlerActive: false },
  'drafts.list': [],
  'contacts.suggest': [],
  'preferences.get': {
    ui: {
      darkMode: false, selectedFolderId: 'acc-1-inbox', selectedMessageId: null,
      collapsedAccountIds: {},
      // Pinned across both accounts and out of alphabetical order, so the
      // Favourites section renders at all and its sort is visible. It carries
      // one of each collision — both Inboxes (two accounts, qualified by
      // account) and both of Personal's Receipts labels (one account, qualified
      // by parent path) — alongside rows that collide with nothing. A fixture
      // where every name collided would look right with the test deleted.
      favoriteFolderIds: [
        'acc-2-l3', 'acc-1-l2', 'acc-1-inbox', 'acc-2-l4', 'acc-2-inbox',
        'acc-1-l1', 'acc-1-l5'
      ],
      threadedView: true,
      unreadFilterByAccount: {}, searchField: 'all'
    },
    lastSyncAt: Date.now() - 120000,
    handleMailtoLinks: false, closeToTray: true, desktopNotifications: true,
    alwaysLoadRemoteImages: false,
    mutedSenders: ['newsletter@example.com'],
    blockedSenders: ['spam@example.com'],
    imageAllowedSenders: ['receipts@example.com']
  }
}

// A name that reads like a list returns one, a save echoes what it was given,
// everything else resolves null. Guessing wrong surfaces as a console error or
// an obviously empty pane rather than as something that looks true and is not.
function fallback(method, args) {
  if (/^(list|search|suggest)/.test(method)) return []
  if (/^count/.test(method)) return 0
  if (/^(save|update|set|patch)/.test(method)) return args[0] ?? null
  return null
}

// One payload per event subscriber that needs one. The reply carries the same
// sender HTML as the thread fixture's first message, since the quoted original
// in the composer is that mail and has the same dark-mode contrast problem.
const SUBSCRIBERS = {
  'compose.onOpen': {
    accountId: 'acc-1',
    to: 'Jan <jan@work.example>',
    cc: '',
    subject: 'Re: Q3 launch date',
    bodyHtml: '',
    bodyText: '',
    quotedHtml:
      '<blockquote>On 31 July, Jan wrote:<br>' +
      '<div style="color:#1a1a1a;font-family:Arial,sans-serif">' +
      '<p>Can we move the launch to the 14th? That gives the printers a week of slack.</p>' +
      '<p style="color:#333">Happy either way, but I would rather not cut it fine.</p>' +
      '</div></blockquote>',
    quotedText: 'On 31 July, Jan wrote:\\n> Can we move the launch to the 14th?',
    inReplyTo: '<m1@work.example>',
    mode: 'reply',
    originalMessageId: 'm1'
  }
}

window.orbitMail = new Proxy({}, {
  get: (_t, ns) => new Proxy({}, {
    get: (_t2, method) => {
      if (typeof method !== 'string') return undefined
      // Event subscribers are synchronous and hand back an unsubscribe. Some
      // also deliver one payload, because the pane behind them renders nothing
      // until they do: #/compose is an empty form until compose.onPayload
      // fires, so a bare no-op leaves the whole composer unlookable. Delivered
      // in a later task so the subscribing effect has finished first, which is
      // the order the real preload produces.
      if (/^on[A-Z]/.test(method)) {
        const payload = SUBSCRIBERS[ns + '.' + method]
        return (cb) => {
          if (payload !== undefined) setTimeout(() => cb(structuredClone(payload)), 0)
          return () => {}
        }
      }
      const key = ns + '.' + method
      return (...args) => {
        const value = key in OVERRIDES ? OVERRIDES[key] : fallback(method, args)
        console.debug('[stub]', key, args, '->', value)
        return Promise.resolve(structuredClone(value))
      }
    }
  })
})
console.info('[ui-preview] window.orbitMail is a stub. Nothing here talks to a mail server.')
`

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname === '/orbit-stub.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(STUB)
    return
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  const file = join(RENDERER_DIR, normalize(rel).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file)) {
    res.writeHead(404).end('not found')
    return
  }

  let body = readFileSync(file)
  if (rel === 'index.html') {
    body = Buffer.from(
      body
        .toString()
        // The stub has to be installed before the app bundle runs.
        .replace(
          '<script type="module"',
          '<script src="./orbit-stub.js"></script>\n    <script type="module"'
        )
        // Google Fonts is the only off-origin fetch the page makes, and waiting
        // on it just slows the preview down.
        .replace(/<link rel="(preconnect|stylesheet)"[^>]*fonts\.(googleapis|gstatic)[^>]*>/g, '')
    )
  }

  res
    .writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    .end(body)
}).listen(PORT, () => {
  console.log(`ui-preview serving ${RENDERER_DIR} on http://localhost:${PORT}`)
  console.log('Ctrl+C to stop. Rebuild (npm run build) to pick up changes.')
})
