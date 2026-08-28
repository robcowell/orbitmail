// What the database layer promises, asserted against the database layer.
//
// This file is run **twice**, by two runners with different drivers:
//
//   npm run test:db    plain node, ~1s, `better-sqlite3` swapped for node:sqlite
//                      (scripts/sqlite-node-shim.mjs). Fast enough to be run
//                      hundreds of times, which is what makes `db-service.ts`
//                      mutation-testable — see scripts/mutation-check.mjs.
//   npm run test:imap  inside Electron, on the real `better-sqlite3` that ships.
//
// Running it in both places is the whole design. The fast runner is only useful
// if it tells the truth about the driver that ships, and a shim is exactly the
// place for a difference to hide; the slow runner is the thing that would say
// so. If a check here passes under `test:db` and fails under `test:imap`, trust
// the second one — the shim is wrong, not the code.
//
// It creates its own account and removes it again, because `test:imap` runs it
// beside a live GreenMail sync and must not disturb that. Nothing here may
// assume an empty database.
import {
  saveAccount,
  getAccountTokens,
  getManualCredentials,
  saveManualAccount,
  getAccountSyncDays,
  updateAccountSyncDays,
  getAccountSignature,
  setAccountSignature,
  getInboxFolderIds,
  listFolders,
  markAllMessagesReadInFolder,
  upsertMessagesBatch,
  backfillSearchTextBatch,
  pruneMessagesOutsideSyncWindow,
  getAccountStorageUsage,
  regroupThreadsIfNeeded,
  getFolderServerCount,
  setFolderServerCount,
  getLatestInboxMessage,
  listMessagesForSweep,
  getFolderMaxUid,
  getFolderUidValidity,
  updateFolderSyncState,
  applyFlagUpdates,
  deleteMessagesByUid,
  setMessageFlag,
  setMessageStarred,
  setMessageRead,
  addAttachment,
  listMessageAttachments,
  findMessagesByRfcId,
  getMessageSummariesByIds,
  listMessageCopies,
  replaceOpenSweepTasks,
  listOpenSweepTasks,
  completeSweepTask,
  listCompletedSweepTasks,
  pruneCompletedSweepTasks,
  upsertFolder,
  upsertMessage,
  removeAccount,
  listAccounts,
  listMessages,
  listThreads,
  countThreads,
  countMessages,
  getThread,
  searchMessages,
  regroupThreadsForAccount,
  setMessageAiAnalysis,
  getMessageAiAnalysis,
  getMessage,
  recordPop3Skipped,
  getPop3SkippedDates,
  prunePop3Skipped
} from '../electron/services/db-service'
import { blockSender, unblockSender, getBlockedSenders } from '../electron/services/preferences-service'
import { saveDraft, deleteDraft, listDrafts } from '../electron/services/draft-service'
import { getRawSqlite } from '../electron/db'
import { suggestContacts } from '../electron/services/contacts'

type Ok = (label: string, condition: boolean, detail?: string) => void
type Section = (name: string) => void

const DAY = 86_400_000

/** A distinctive address so a leftover row is obvious rather than mysterious. */
const CONTRACT_EMAIL = 'db-contract@orbit.invalid'

interface Seed {
  uid: number
  from?: string
  to?: string
  subject?: string
  body?: string
  date?: number
  messageId?: string
  inReplyTo?: string | null
  references?: string | null
  isRead?: boolean
}

export function runDbContract(ok: Ok, section: Section): void {
  const account = saveAccount('imap', {
    authType: 'oauth',
    accessToken: 'contract',
    email: CONTRACT_EMAIL,
    displayName: 'DB Contract'
  })
  const inbox = upsertFolder(account.id, 'CONTRACT/INBOX', 'Contract Inbox', 'inbox')
  const sent = upsertFolder(account.id, 'CONTRACT/SENT', 'Contract Sent', 'sent')
  const label = upsertFolder(account.id, 'CONTRACT/LABEL', 'Contract Label', 'custom')

  const base = 1_700_000_000_000
  let seq = 0
  const put = (folderId: string, seed: Seed): string =>
    upsertMessage({
      folderId,
      accountId: account.id,
      uid: seed.uid,
      messageId: seed.messageId,
      inReplyTo: seed.inReplyTo ?? null,
      references: seed.references ?? null,
      from: seed.from ?? 'Contract Sender <sender@orbit.invalid>',
      to: seed.to ?? CONTRACT_EMAIL,
      subject: seed.subject ?? `contract subject ${++seq}`,
      snippet: 'snippet',
      date: seed.date ?? base + seq * 1000,
      isRead: seed.isRead ?? true,
      isStarred: false,
      hasAttachments: false,
      bodyText: seed.body ?? 'contract body'
    }).id

  const blockedBefore = [...getBlockedSenders()]

  try {
    // -----------------------------------------------------------------------
    section('Blocked senders: their mail, and nothing else, disappears')
    // -----------------------------------------------------------------------
    {
      // Four senders that a naive predicate confuses. The blocked one; one whose
      // address merely *contains* it; one whose display name contains it; and
      // one whose address holds a LIKE wildcard.
      // Distinct search tokens, not "bob" and "notbob": `%from%bob%` matches
      // "from notbob" too, and an assertion written that way passes whether or
      // not the block is applied — it did, and the runner caught it.
      put(inbox.id, { uid: 101, from: '"Bob" <bob@orbit.invalid>', subject: 'from bob',
        body: 'zephyrblocked' })
      put(inbox.id, { uid: 102, from: '"Not Bob" <notbob@orbit.invalid>', subject: 'from notbob',
        body: 'zephyrallowed' })
      put(inbox.id, { uid: 103, from: 'bare@orbit.invalid', subject: 'bare address' })
      put(inbox.id, { uid: 104, from: '"Ann" <a_b@orbit.invalid>', subject: 'underscore' })
      put(inbox.id, { uid: 105, from: '"Ann" <axb@orbit.invalid>', subject: 'not underscore' })
      // The same blocked person, in Sent. A Sent row's from_addr is the account
      // owner in the app, but the exemption is what stops a blocklist entry that
      // matches the owner emptying their whole Sent folder.
      put(sent.id, { uid: 201, from: '"Bob" <bob@orbit.invalid>', subject: 'sent to bob' })

      const subjectsIn = (folderId: string): string[] =>
        listMessages(folderId, 500).map((m) => m.subject)

      const before = subjectsIn(inbox.id)
      ok('a sender is visible before being blocked', before.includes('from bob'))

      blockSender('bob@orbit.invalid')
      const after = subjectsIn(inbox.id)
      ok('blocking hides their mail from the list', !after.includes('from bob'))
      // The reason the predicate matches `<addr>` and not a bare substring: a
      // `LIKE '%bob@…%'` would take this one with it, and losing mail from a
      // different person is a silent, baffling failure.
      ok('and leaves an address that merely contains theirs alone',
        after.includes('from notbob'), after.join(', '))
      ok('the count agrees with the list',
        countMessages(inbox.id) === after.length,
        `${countMessages(inbox.id)} counted, ${after.length} listed`)
      // Search spans folders, so it uses the unscoped blocklist. Without that,
      // "blocked" would mean only "not in the list I was looking at".
      ok('and search cannot find them either',
        searchMessages('zephyrblocked', account.id).length === 0)
      ok('while it still finds the sender who was not blocked',
        searchMessages('zephyrallowed', account.id).length === 1)
      ok('a Sent folder is exempt, so the owner cannot empty their own Sent',
        subjectsIn(sent.id).includes('sent to bob'))
      ok('and a conversation made only of blocked mail leaves the thread list',
        !listThreads(inbox.id, 500).some((t) => t.subject === 'from bob'))
      ok('with the thread count agreeing',
        countThreads(inbox.id) === listThreads(inbox.id, 500).length,
        `${countThreads(inbox.id)} counted, ${listThreads(inbox.id, 500).length} listed`)

      unblockSender('bob@orbit.invalid')
      ok('unblocking brings it back', subjectsIn(inbox.id).includes('from bob'))

      // A bare `from_addr` with no angle brackets — POP3 and some senders — has
      // to match the equality arm of the predicate, not the `<addr>` one.
      blockSender('bare@orbit.invalid')
      ok('an address stored without angle brackets is blocked too',
        !subjectsIn(inbox.id).includes('bare address'))
      unblockSender('bare@orbit.invalid')

      // `_` is a LIKE wildcard. Unescaped, blocking `a_b@` also hides `axb@`.
      blockSender('a_b@orbit.invalid')
      const escaped = subjectsIn(inbox.id)
      ok('a wildcard character in an address is escaped, not honoured',
        !escaped.includes('underscore') && escaped.includes('not underscore'),
        escaped.join(', '))
      unblockSender('a_b@orbit.invalid')
    }

    // -----------------------------------------------------------------------
    section('Threading: a reply that omits References still joins its thread')
    // -----------------------------------------------------------------------
    {
      // The split this regroup exists to heal. B answers A with In-Reply-To and
      // no References — which many clients send — so keying on references[0]
      // alone puts it in a thread of its own.
      const a = put(inbox.id, {
        uid: 301, messageId: '<a@orbit.invalid>', subject: 'Launch', date: base + 10 * DAY
      })
      const b = put(inbox.id, {
        uid: 302, messageId: '<b@orbit.invalid>', inReplyTo: '<a@orbit.invalid>',
        subject: 'Re: Launch', date: base + 11 * DAY
      })
      // C references both, in a different case and with ragged whitespace —
      // Message-IDs are practically case-insensitive and clients vary.
      const c = put(inbox.id, {
        uid: 303, messageId: '<C@ORBIT.INVALID>',
        references: '  <A@Orbit.Invalid>\n\t<b@orbit.invalid> ',
        subject: 'Re: Launch', date: base + 12 * DAY
      })
      // A message with no Message-ID at all falls back to its subject key.
      const d = put(inbox.id, { uid: 304, subject: 'Re: Orphan topic', date: base + 13 * DAY })

      regroupThreadsForAccount(account.id)
      const threadOf = (id: string): string | null => {
        const row = getMessage(id)
        return row ? row.threadId ?? null : null
      }

      ok('a reply with only In-Reply-To joins its parent',
        threadOf(a) === threadOf(b), `${threadOf(a)} vs ${threadOf(b)}`)
      ok('and one that references both joins the same thread',
        threadOf(c) === threadOf(a), `${threadOf(c)} vs ${threadOf(a)}`)
      // The root is the *earliest* message in the set, not whichever was seen
      // first: it is what the conversation is keyed and cached under, and a key
      // that moves invalidates every cached summary hanging off it.
      ok('the thread is keyed on the conversation opener',
        threadOf(a) === 'a@orbit.invalid', String(threadOf(a)))
      ok('a message with no Message-ID falls back to its subject',
        threadOf(d) === 'subj:orphan topic', String(threadOf(d)))
      ok('and the three linked messages read back as one conversation',
        getThread(account.id, threadOf(a)!).length === 3,
        `${getThread(account.id, threadOf(a)!).length} messages`)
      // Regrouping is idempotent — it runs on every upgrade and after every
      // account change, so a second pass that moved anything would be a bug.
      regroupThreadsForAccount(account.id)
      ok('and running it again changes nothing',
        threadOf(a) === 'a@orbit.invalid' && threadOf(c) === threadOf(a))
    }

    // -----------------------------------------------------------------------
    section('Thread listing: one email under two Gmail labels is one message')
    // -----------------------------------------------------------------------
    {
      // Gmail exposes each label as an IMAP folder, so the same email is stored
      // once per label. Counted naively, a conversation grows a message every
      // time the user adds a label to it.
      const shared = { messageId: '<dup@orbit.invalid>', subject: 'Labelled', date: base + 20 * DAY }
      put(inbox.id, { uid: 401, ...shared })
      put(label.id, { uid: 402, ...shared })
      regroupThreadsForAccount(account.id)

      const thread = getThread(account.id, 'dup@orbit.invalid')
      ok('a message stored under two labels reads back once',
        thread.length === 1, `${thread.length} copies`)
      const row = listThreads(inbox.id, 500).find((t) => t.subject === 'Labelled')
      ok('and its conversation counts one message, not two',
        row?.messageCount === 1, `messageCount=${row?.messageCount}`)
    }

    // -----------------------------------------------------------------------
    section('A long conversation is capped at its most recent end')
    // -----------------------------------------------------------------------
    {
      // The cap exists so one runaway thread cannot marshal an unbounded reply
      // set over IPC. Which end it keeps is the part that matters: the newest,
      // because that is what the user is reading and replying to.
      const root = '<long@orbit.invalid>'
      // The root is strictly the earliest. Sharing a timestamp with a reply is
      // not a tie the code resolves in the opener's favour — it breaks ties
      // lexicographically, and `long-0@` sorts before `long@`. Written the other
      // way this section asserted a root the code never picks.
      for (let i = 0; i < 12; i++) {
        put(inbox.id, {
          uid: 500 + i,
          messageId: `<long-${i}@orbit.invalid>`,
          references: root,
          subject: 'Long thread',
          date: base + 30 * DAY + (i + 1) * 1000
        })
      }
      put(inbox.id, { uid: 499, messageId: root, subject: 'Long thread', date: base + 30 * DAY })
      regroupThreadsForAccount(account.id)

      const key = 'long@orbit.invalid'
      ok('the whole conversation is there when nothing caps it',
        getThread(account.id, key).length === 13,
        `${getThread(account.id, key).length} messages`)
      const capped = getThread(account.id, key, 5)
      ok('a cap keeps exactly that many', capped.length === 5, `${capped.length} messages`)
      ok('and it keeps the newest, not the first five',
        capped[capped.length - 1]?.messageId === '<long-11@orbit.invalid>',
        String(capped[capped.length - 1]?.messageId))
      // Reading order, not recency order: the cap chooses by date descending and
      // then hands them back ascending, and getting that backwards renders a
      // conversation upside down.
      ok('and hands them back oldest-first for reading',
        capped[0]!.date < capped[capped.length - 1]!.date)
    }

    // -----------------------------------------------------------------------
    section('Search: scoped to a field, an account, and a sane limit')
    // -----------------------------------------------------------------------
    {
      put(inbox.id, {
        uid: 601, subject: 'quarterly figures', body: 'nothing relevant here',
        from: '"Zed" <zed@orbit.invalid>', date: base + 40 * DAY
      })
      put(inbox.id, {
        uid: 602, subject: 'unrelated heading', body: 'the word quarterly appears in the body',
        from: '"Yan" <yan@orbit.invalid>', date: base + 41 * DAY
      })

      const subjects = searchMessages('quarterly', account.id, 'subject').map((m) => m.subject)
      ok('a subject search does not reach into bodies',
        subjects.includes('quarterly figures') && !subjects.includes('unrelated heading'),
        subjects.join(', '))
      const all = searchMessages('quarterly', account.id, 'all').map((m) => m.subject)
      ok('and an all search reaches both',
        all.includes('quarterly figures') && all.includes('unrelated heading'),
        all.join(', '))
      ok('a from search matches the sender and not the subject',
        searchMessages('zed', account.id, 'from').length === 1)
      // An empty accountId is a caller bug. Treating it as "search everything"
      // would hand a renderer with a missing id every account's mail.
      ok('an empty account id searches nothing, unlike an explicit null',
        searchMessages('quarterly', '').length === 0 &&
          searchMessages('quarterly', null).length > 0)
      ok('a query with no searchable characters matches nothing',
        searchMessages('  ***  ', account.id).length === 0)
      // limit crosses IPC from the renderer.
      ok('a nonsensical limit is clamped rather than trusted',
        searchMessages('contract', account.id, 'all', -5).length >= 1 &&
          searchMessages('contract', account.id, 'all', 1).length === 1)
    }

    // -----------------------------------------------------------------------
    section('Sync must not overwrite what the AI features cached')
    // -----------------------------------------------------------------------
    {
      // The analysis lives on the messages row as a partial column, so an
      // ordinary re-sync of the same UID has to leave it alone. If it did not,
      // every poll would silently re-bill the user for work already done.
      const id = put(inbox.id, { uid: 701, subject: 'analysed', body: 'first body' })
      setMessageAiAnalysis(id, '{"summary":"kept"}', base)
      const again = upsertMessage({
        folderId: inbox.id, accountId: account.id, uid: 701,
        from: 'Contract Sender <sender@orbit.invalid>', to: CONTRACT_EMAIL,
        subject: 'analysed', snippet: 'snippet', date: base,
        isRead: true, isStarred: false, hasAttachments: false, bodyText: 'second body'
      })
      ok('re-syncing the same UID updates the row rather than adding one',
        again.id === id && again.isNew === false, `${again.id === id} / isNew=${again.isNew}`)
      ok('and the cached analysis survives it',
        getMessageAiAnalysis(id)?.json === '{"summary":"kept"}',
        String(getMessageAiAnalysis(id)?.json))
      ok('while the body it re-synced did change',
        getMessage(id)?.bodyText === 'second body')
    }

    // -----------------------------------------------------------------------
    section('POP3: an out-of-window message is remembered by date, not by flag')
    // -----------------------------------------------------------------------
    {
      // Storing a flag would mean "already skipped" forever. Storing the date
      // means widening syncDays brings the message back into range with nothing
      // to invalidate — which is the whole reason the column holds a date.
      recordPop3Skipped(account.id, 'UIDL-OLD', base - 100 * DAY)
      recordPop3Skipped(account.id, 'UIDL-RECENT', base - 2 * DAY)
      const dates = getPop3SkippedDates(account.id)
      ok('a skipped message keeps the date it was skipped for',
        dates.get('UIDL-OLD') === base - 100 * DAY, String(dates.get('UIDL-OLD')))
      ok('so a wider window can tell which ones are now in range',
        [...dates.values()].filter((d) => d >= base - 30 * DAY).length === 1)
      // Re-recording the same UIDL must update, not duplicate: the maildrop is
      // re-listed on every poll.
      recordPop3Skipped(account.id, 'UIDL-OLD', base - 99 * DAY)
      ok('re-recording one updates it in place',
        getPop3SkippedDates(account.id).size === 2 &&
          getPop3SkippedDates(account.id).get('UIDL-OLD') === base - 99 * DAY)
      // Message numbers shift on delete, so identity is the UIDL — and a UIDL
      // the maildrop no longer lists is a message that is gone.
      prunePop3Skipped(account.id, new Set(['UIDL-RECENT']))
      const pruned = getPop3SkippedDates(account.id)
      ok('and one the server no longer lists is forgotten',
        pruned.size === 1 && pruned.has('UIDL-RECENT'), [...pruned.keys()].join(', '))
    }
    // -----------------------------------------------------------------------
    section('The unified inbox is every inbox, not the first one')
    // -----------------------------------------------------------------------
    {
      // `unified` is not a folder. Every read path has to expand it to the set of
      // inbox folder ids and scope to those — and each of those expansions is a
      // separate `folderId === 'unified'` branch that a test naming a real folder
      // never reaches. This suite runs beside other accounts' inboxes in
      // `test:imap`, so it asserts what it contributed, never a total.
      const mine = new Set(listMessages(inbox.id, 500).map((m) => m.id))
      ok('this account\'s inbox is one of the unified ones',
        getInboxFolderIds().includes(inbox.id))
      const unified = listMessages('unified', 1000)
      ok('the unified list contains this inbox\'s mail',
        unified.length > 0 && [...mine].every((id) => unified.some((m) => m.id === id)),
        `${unified.length} unified, ${mine.size} mine`)
      ok('and it is not scoped to one folder either',
        countMessages('unified') >= countMessages(inbox.id),
        `${countMessages('unified')} unified, ${countMessages(inbox.id)} in this inbox`)
      ok('the unified thread list is populated too',
        listThreads('unified', 1000).length > 0 && countThreads('unified') > 0,
        `${countThreads('unified')} threads`)
      // The Sent folder is deliberately not part of it: `unified` means inboxes.
      ok('a Sent folder is not swept into the unified view',
        !listMessages('unified', 1000).some((m) => m.folderId === sent.id))

      // The new-mail notification reads the newest unified inbox row, and names
      // the account it arrived for.
      const latest = getLatestInboxMessage()
      ok('the newest inbox message is found for the notifier', latest !== null)
      // The label has to be the *address*, not merely something non-empty: with
      // the `||` chain broken the display name is also non-empty and also not
      // the fallback, so "it is not 'Orbit Mail'" passes against a label that
      // names the wrong thing. The mutation check said so.
      //
      // Which account wins is not this suite's to assume. Under `test:db` there
      // is one inbox; under `test:imap` there is a live GreenMail account whose
      // mail is newer, and asserting the contract account's own address failed
      // there — correctly. So the address is looked up from whichever message
      // came back.
      const latestOwner = latest ? getMessage(latest.id)?.accountId : undefined
      const ownerEmail = listAccounts().find((a) => a.id === latestOwner)?.email
      ok('and it is named with that message\'s account address',
        latest?.accountLabel === ownerEmail && typeof ownerEmail === 'string',
        `${latest?.accountLabel} vs ${ownerEmail}`)

      // The sweep reader has its own unified branch, and its own unread scope.
      const sweepAll = listMessagesForSweep(inbox.id, 'all', 100)
      ok('the sweep reader sees this folder\'s mail', sweepAll.length > 0)
      ok('and its unified branch reaches it as well',
        listMessagesForSweep('unified', 'all', 500).some((m) => mine.has(m.id)))
      const unread = put(inbox.id, { uid: 801, subject: 'unread for sweep', isRead: false })
      const sweepUnread = listMessagesForSweep(inbox.id, 'unread', 100)
      ok('an unread scope takes only the unread',
        sweepUnread.some((m) => m.id === unread) && sweepUnread.length < sweepAll.length + 1,
        `${sweepUnread.length} unread of ${sweepAll.length + 1}`)
      ok('while the unread-only list and count agree with each other',
        listMessages(inbox.id, 500, 0, true).length === countMessages(inbox.id, true),
        `${listMessages(inbox.id, 500, 0, true).length} vs ${countMessages(inbox.id, true)}`)
    }

    // -----------------------------------------------------------------------
    section('A local draft appears in its Drafts folder, at the top, once')
    // -----------------------------------------------------------------------
    {
      // Drafts live in their own table, so the Drafts folder has to merge them in
      // on read. Prepended, because a draft is always newer than anything synced
      // and it is what the user came to the folder for — and only on the first
      // page, or every page would repeat them.
      const drafts = upsertFolder(account.id, 'CONTRACT/DRAFTS', 'Contract Drafts', 'drafts')
      put(drafts.id, { uid: 901, subject: 'synced draft row', date: base })
      const draftId = saveDraft({
        accountId: account.id, to: 'someone@orbit.invalid',
        subject: 'local draft', bodyText: 'unfinished', bodyHtml: '<p>unfinished</p>'
      })
      ok('the draft was saved', typeof draftId === 'string' && listDrafts(account.id).length === 1)

      const page = listMessages(drafts.id, 500)
      ok('it shows in the Drafts folder', page.some((m) => m.draftId === draftId))
      ok('and at the top of it, above the synced row',
        page[0]?.draftId === draftId, String(page[0]?.subject))
      ok('the count includes it', countMessages(drafts.id) === page.length,
        `${countMessages(drafts.id)} counted, ${page.length} listed`)
      ok('and the thread list shows it too',
        listThreads(drafts.id, 500).some((t) => t.draftId === draftId))
      // Offset 0 only: paging past the first page must not repeat them.
      ok('a later page does not repeat the drafts',
        !listMessages(drafts.id, 500, 1).some((m) => m.draftId === draftId))
      // A draft is not unread mail, so an unread filter must not surface it.
      ok('and an unread filter does not surface a draft',
        !listMessages(drafts.id, 500, 0, true).some((m) => m.draftId === draftId))

      // An empty subject has to read as something. `||` not `??`: '' is the value
      // an untitled draft actually has, and `?? ` would let it through.
      const untitled = saveDraft({
        accountId: account.id, to: 'someone@orbit.invalid', subject: '', bodyText: 'no subject here'
      })
      const untitledRow = listMessages(drafts.id, 500).find((m) => m.draftId === untitled)
      ok('an untitled draft is labelled rather than left blank',
        untitledRow?.subject === '(no subject)', String(untitledRow?.subject))
      const untitledThread = listThreads(drafts.id, 500).find((t) => t.draftId === untitled)
      ok('and the same in the thread list',
        untitledThread?.subject === '(no subject)', String(untitledThread?.subject))

      deleteDraft(draftId!)
      deleteDraft(untitled!)
      ok('deleting them takes them out of the folder',
        !listMessages(drafts.id, 500).some((m) => m.draftId))
    }

    // -----------------------------------------------------------------------
    section('A conversation row describes every message in it')
    // -----------------------------------------------------------------------
    {
      // A thread row is an aggregate: starred if *any* message is, unread if any
      // unread copy is in the folder being viewed, and labelled with the distinct
      // participants. Asserting only that a row appears proves none of it.
      const key = '<agg@orbit.invalid>'
      const first = put(inbox.id, {
        uid: 1001, messageId: key, subject: 'Aggregate',
        from: '"Ada" <ada@orbit.invalid>', date: base + 50 * DAY, isRead: true
      })
      put(inbox.id, {
        uid: 1002, messageId: '<agg2@orbit.invalid>', references: key, subject: 'Re: Aggregate',
        from: '"Bea" <bea@orbit.invalid>', date: base + 51 * DAY, isRead: false
      })
      regroupThreadsForAccount(account.id)
      const rowOf = () => listThreads(inbox.id, 500).find((t) => t.threadId === 'agg@orbit.invalid')

      ok('the row counts both messages', rowOf()?.messageCount === 2,
        `messageCount=${rowOf()?.messageCount}`)
      ok('and takes its subject and date from the newest',
        rowOf()?.date === base + 51 * DAY && rowOf()?.from.includes('Bea'),
        `${rowOf()?.from} @ ${rowOf()?.date}`)
      ok('it is unread while any copy in the folder is',
        rowOf()?.hasUnread === true)
      ok('it names both participants, oldest first',
        JSON.stringify(rowOf()?.participants) === JSON.stringify(['Ada', 'Bea']),
        JSON.stringify(rowOf()?.participants))
      ok('and it is not starred while none of them is',
        rowOf()?.isStarred === false)

      setMessageStarred(first, true)
      ok('starring one message stars the conversation', rowOf()?.isStarred === true)
      setMessageFlag(first, 'red')
      ok('and a flag on one message colours the row', rowOf()?.flagColor === 'red',
        String(rowOf()?.flagColor))

      // An attachment on one message marks the row.
      const attachmentId = addAttachment(first, 'report.pdf', 'application/pdf', 1234, null)
      put(inbox.id, {
        uid: 1001, messageId: key, subject: 'Aggregate',
        from: '"Ada" <ada@orbit.invalid>', date: base + 50 * DAY, isRead: true
      })
      ok('the attachment is listed against its message',
        listMessageAttachments(first).some((a) => a.id === attachmentId))
      ok('and the message reports having one', getMessage(first)?.hasAttachments === false,
        'has_attachments is set by the sync writer, not by adding a row')

      setMessageStarred(first, false)
      setMessageFlag(first, null)
    }

    // -----------------------------------------------------------------------
    section('Flag updates from the server: only what changed, and the count with it')
    // -----------------------------------------------------------------------
    {
      // Every poll hands this the whole folder's flags. Writing all of them back
      // would be a folder-sized write on every sync, so it skips the rows that
      // already agree — and the skip is what the returned count means.
      const f = upsertFolder(account.id, 'CONTRACT/FLAGS', 'Contract Flags', 'custom')
      const m1 = put(f.id, { uid: 1101, subject: 'flag one', isRead: false })
      put(f.id, { uid: 1102, subject: 'flag two', isRead: true })

      ok('an empty update list is not a database write',
        applyFlagUpdates(f.id, []) === 0)
      ok('flags that already agree change nothing',
        applyFlagUpdates(f.id, [
          { uid: 1101, isRead: false, isStarred: false },
          { uid: 1102, isRead: true, isStarred: false }
        ]) === 0)
      ok('a uid that was never synced here is skipped, not created',
        applyFlagUpdates(f.id, [{ uid: 9999, isRead: true, isStarred: true }]) === 0)
      ok('and a real change is applied and counted',
        applyFlagUpdates(f.id, [{ uid: 1101, isRead: true, isStarred: true }]) === 1)
      ok('the row shows it', getMessage(m1)?.isRead === true && getMessage(m1)?.isStarred === true)

      // Unstarring clears a colour flag: the colour is a refinement of the star,
      // and leaving it behind gives a row with a colour and no star.
      setMessageFlag(m1, 'blue')
      ok('a colour flag stars the message too', getMessage(m1)?.isStarred === true)
      applyFlagUpdates(f.id, [{ uid: 1101, isRead: true, isStarred: false }])
      ok('unstarring from the server clears the colour with it',
        getMessage(m1)?.flagColor === null, String(getMessage(m1)?.flagColor))

      // The folder's unread count is recomputed only when something changed.
      ok('marking read leaves no unread in this folder',
        countMessages(f.id, true) === 0, `${countMessages(f.id, true)} unread`)

      ok('deleting by uid removes exactly those rows',
        deleteMessagesByUid(f.id, [1102]) === 1 && listMessages(f.id, 100).length === 1)
      ok('and an empty uid list deletes nothing',
        deleteMessagesByUid(f.id, []) === 0 && listMessages(f.id, 100).length === 1)
    }

    // -----------------------------------------------------------------------
    section('Folder sync state: a partial patch touches only what it names')
    // -----------------------------------------------------------------------
    {
      // The sync layer patches these one or two at a time. An `undefined` field
      // means "leave it", not "set it to undefined" — writing the whole object
      // would clear a UIDVALIDITY every time a lastSyncAt was recorded, and a
      // cleared UIDVALIDITY triggers a full folder rebuild.
      const f = upsertFolder(account.id, 'CONTRACT/STATE', 'Contract State', 'custom')
      updateFolderSyncState(f.id, { uidValidity: 42, highestSyncedUid: 7, lastSyncAt: base })
      ok('the state is stored', getFolderUidValidity(f.id) === 42,
        String(getFolderUidValidity(f.id)))
      updateFolderSyncState(f.id, { lastSyncAt: base + 1000 })
      ok('patching one field leaves the others alone',
        getFolderUidValidity(f.id) === 42 && getFolderMaxUid(f.id) === 7,
        `uidValidity=${getFolderUidValidity(f.id)} maxUid=${getFolderMaxUid(f.id)}`)
      updateFolderSyncState(f.id, {})
      ok('and an empty patch is not a write at all',
        getFolderUidValidity(f.id) === 42 && getFolderMaxUid(f.id) === 7)

      // The next UID to ask the server for is the higher of what is stored and
      // what is actually on disk — a message can outlive the marker, and the
      // marker can outlive every message (an emptied folder).
      put(f.id, { uid: 99, subject: 'high uid' })
      ok('a synced message above the marker raises it',
        getFolderMaxUid(f.id) === 99, String(getFolderMaxUid(f.id)))
      updateFolderSyncState(f.id, { highestSyncedUid: 500 })
      ok('and a marker above every message wins instead',
        getFolderMaxUid(f.id) === 500, String(getFolderMaxUid(f.id)))
      const empty = upsertFolder(account.id, 'CONTRACT/EMPTY', 'Contract Empty', 'custom')
      ok('a folder with neither reports nothing rather than zero',
        getFolderMaxUid(empty.id) === null, String(getFolderMaxUid(empty.id)))
      ok('and an unsynced folder has no UIDVALIDITY yet',
        getFolderUidValidity(empty.id) === null)
    }

    // -----------------------------------------------------------------------
    section('A folder is re-typed on every sync, and only written when it moved')
    // -----------------------------------------------------------------------
    {
      // The type used to be frozen at first sight, so a folder mis-typed once
      // stayed that way forever and no detection fix could reach an existing
      // install. It is re-read on every sync now — but only written when it
      // actually differs, because this runs for every folder on every sync.
      // Read back through listFolders, not from upsertFolder's return value. The
      // return carries the *arguments* — it reports the type it was asked for
      // whether or not a row was written — so asserting on it passes against a
      // version that never updates anything. The mutation check caught exactly
      // that here.
      const stored = (): { type: string; isVirtualView: boolean } | undefined => {
        const row = listFolders(account.id).find((x) => x.imapPath === 'CONTRACT/RETYPE')
        return row ? { type: row.type, isVirtualView: row.isVirtualView } : undefined
      }
      const f = upsertFolder(account.id, 'CONTRACT/RETYPE', 'Contract Retype', 'custom')
      ok('a new folder is stored with the type it was given', stored()?.type === 'custom')
      const again = upsertFolder(account.id, 'CONTRACT/RETYPE', 'Contract Retype', 'trash')
      ok('the same path is one folder, not two', again.id === f.id &&
        listFolders(account.id).filter((x) => x.imapPath === 'CONTRACT/RETYPE').length === 1)
      ok('and a re-typed folder is written, not just reported',
        stored()?.type === 'trash', String(stored()?.type))
      // Unchanged is the common case — every folder, every sync — and must not
      // write. Observable only as "the value is still right afterwards", which
      // is what a second identical call checks.
      upsertFolder(account.id, 'CONTRACT/RETYPE', 'Contract Retype', 'trash')
      ok('and calling it again with the same type leaves it alone',
        stored()?.type === 'trash')
      upsertFolder(account.id, 'CONTRACT/RETYPE', 'Contract Retype', 'trash', true)
      ok('a virtual-view flag is written the same way',
        stored()?.isVirtualView === true, String(stored()?.isVirtualView))
      upsertFolder(account.id, 'CONTRACT/RETYPE', 'Contract Retype', 'trash', false)
      ok('and cleared the same way', stored()?.isVirtualView === false)
    }

    // -----------------------------------------------------------------------
    section('Sync window: a day count is a whole number of days, or off')
    // -----------------------------------------------------------------------
    {
      ok('a new account gets the default window', getAccountSyncDays(account.id) === 90,
        String(getAccountSyncDays(account.id)))
      updateAccountSyncDays(account.id, 30)
      ok('a chosen window is stored', getAccountSyncDays(account.id) === 30)
      // Zero and below mean "everything", which is a real setting and not a bug.
      updateAccountSyncDays(account.id, 0)
      ok('zero means no window rather than an empty one',
        getAccountSyncDays(account.id) === 0)
      updateAccountSyncDays(account.id, -5)
      ok('and a negative one is the same thing, not a negative cutoff',
        getAccountSyncDays(account.id) === 0, String(getAccountSyncDays(account.id)))
      // Between 0 and 1 a truncating conversion gives 0 — which is "everything",
      // the opposite of the shortest possible window the caller asked for.
      updateAccountSyncDays(account.id, 0.4)
      ok('a fraction of a day is at least one day, never no window',
        getAccountSyncDays(account.id) === 1, String(getAccountSyncDays(account.id)))
      updateAccountSyncDays(account.id, 7.6)
      ok('and a fractional count is rounded, not truncated',
        getAccountSyncDays(account.id) === 8, String(getAccountSyncDays(account.id)))
      updateAccountSyncDays(account.id, 90)
    }

    // -----------------------------------------------------------------------
    section('Per-account odds and ends that have to round-trip')
    // -----------------------------------------------------------------------
    {
      ok('an account with no signature reads as empty, not as null',
        getAccountSignature(account.id) === '', JSON.stringify(getAccountSignature(account.id)))
      setAccountSignature(account.id, '  Rob\n')
      ok('a signature is stored trimmed', getAccountSignature(account.id) === 'Rob',
        JSON.stringify(getAccountSignature(account.id)))
      // Whitespace-only is "no signature", not a signature made of spaces —
      // otherwise every message gets a blank block appended to it.
      setAccountSignature(account.id, '   ')
      ok('and a whitespace-only one is no signature at all',
        getAccountSignature(account.id) === '',
        JSON.stringify(getAccountSignature(account.id)))

      // Credentials are stored as one blob and read back by auth type. Asking
      // for the wrong type must give nothing rather than the wrong shape: the
      // caller would otherwise reach for a password that is not there, or an
      // access token that is really a hostname.
      ok('an OAuth account reads back as OAuth',
        getAccountTokens(account.id)?.accessToken === 'contract',
        String(getAccountTokens(account.id)?.accessToken))
      ok('and refuses to answer as a password account',
        getManualCredentials(account.id) === null)

      const manual = saveManualAccount('imap', {
        authType: 'password', email: 'db-contract-manual@orbit.invalid',
        displayName: 'Manual', username: 'user', password: 'pw',
        incoming: { host: 'in.orbit.invalid', port: 993, security: 'tls' },
        outgoing: { host: 'out.orbit.invalid', port: 587, security: 'starttls' }
      })
      try {
        ok('a password account reads back as one',
          getManualCredentials(manual.id)?.password === 'pw',
          String(getManualCredentials(manual.id)?.username))
        ok('and refuses to answer as an OAuth account',
          getAccountTokens(manual.id) === null)
        ok('an account that does not exist has no credentials either',
          getAccountTokens('no-such-account') === null &&
            getManualCredentials('no-such-account') === null)
      } finally {
        removeAccount(manual.id)
      }

      // A Message-ID lookup is how undo finds a message that moved folders.
      const msg = put(inbox.id, { uid: 1201, messageId: '<lookup@orbit.invalid>', subject: 'lookup' })
      ok('a message is findable by its RFC id',
        findMessagesByRfcId(account.id, '<lookup@orbit.invalid>').some((r) => r.id === msg))
      ok('an empty account id finds nothing rather than every account\'s',
        findMessagesByRfcId('', '<lookup@orbit.invalid>').length === 0)
      ok('and an empty Message-ID finds nothing rather than every message',
        findMessagesByRfcId(account.id, '').length === 0)

      ok('summaries can be fetched by id', getMessageSummariesByIds([msg]).length === 1)
      ok('and an empty id list is not a query at all',
        getMessageSummariesByIds([]).length === 0)
      ok('the copies of a message include itself',
        listMessageCopies([msg]).some((c) => c.id === msg))
      ok('and an empty list has no copies', listMessageCopies([]).length === 0)
    }

    // -----------------------------------------------------------------------
    section('Sweep tasks: swept ones are replaced, completed ones age out')
    // -----------------------------------------------------------------------
    {
      const task = (id: string): {
        id: string; task: string; priority: 'high'; sourceMessageId: string
        sourceSubject: string; sourceFrom: string
      } => ({
        id, task: `do ${id}`, priority: 'high', sourceMessageId: 'm', sourceSubject: 's',
        sourceFrom: 'f'
      })
      replaceOpenSweepTasks(inbox.id, [task('t1'), task('t2')], base)
      ok('a sweep stores its tasks', listOpenSweepTasks(inbox.id).length === 2)
      replaceOpenSweepTasks(inbox.id, [task('t3')], base + 1000)
      ok('and the next sweep replaces them rather than appending',
        listOpenSweepTasks(inbox.id).length === 1 &&
          listOpenSweepTasks(inbox.id)[0]!.id === 't3',
        `${listOpenSweepTasks(inbox.id).length} open`)

      completeSweepTask(inbox.id, 't3', base + 2000)
      ok('completing one moves it out of the open list',
        listOpenSweepTasks(inbox.id).length === 0)
      ok('and into the completed history',
        listCompletedSweepTasks(inbox.id).some((t) => t.id === 't3'))

      // Pruning is strictly older-than: a task completed exactly at the cutoff
      // is inside the retention window, not outside it.
      pruneCompletedSweepTasks(base + 2000)
      ok('a task completed exactly at the cutoff is kept',
        listCompletedSweepTasks(inbox.id).some((t) => t.id === 't3'))
      pruneCompletedSweepTasks(base + 2001)
      ok('and one older than it is dropped',
        !listCompletedSweepTasks(inbox.id).some((t) => t.id === 't3'))
    }

    // -----------------------------------------------------------------------
    section('Message-ID canonicalisation, and the threads it decides')
    // -----------------------------------------------------------------------
    {
      // A Message-ID is trimmed, un-bracketed and lowercased before anything
      // compares it. Each of those steps decides which messages are the same
      // conversation, and clients are inconsistent enough that all three matter.
      const f = upsertFolder(account.id, 'CONTRACT/IDS', 'Contract Ids', 'custom')
      const threadOf = (id: string): string | null => getMessage(id)?.threadId ?? null

      // Only a *matched* pair of brackets comes off. A ragged one is part of the
      // id: stripping it would turn `<abc` into `ab`, and two different broken
      // ids into the same thread.
      const ragged = put(f.id, { uid: 1301, messageId: '<ragged@orbit.invalid', subject: 'Ragged' })
      regroupThreadsForAccount(account.id)
      ok('an unmatched opening bracket is kept, not half-stripped',
        threadOf(ragged) === '<ragged@orbit.invalid', String(threadOf(ragged)))

      // An empty Message-ID is not an identity. Treated as one, every message
      // that has one lands in the same conversation.
      const blank = put(f.id, { uid: 1302, messageId: '', subject: 'Blank id topic' })
      const blank2 = put(f.id, { uid: 1303, messageId: '   ', subject: 'Other blank topic' })
      regroupThreadsForAccount(account.id)
      ok('an empty Message-ID falls back to the subject',
        threadOf(blank) === 'subj:blank id topic', String(threadOf(blank)))
      ok('and a whitespace-only one does not group with it',
        threadOf(blank2) === 'subj:other blank topic' && threadOf(blank2) !== threadOf(blank),
        String(threadOf(blank2)))

      // Two messages that share a References entry but neither of which has that
      // entry as its own Message-ID. Nothing links them unless the ids a message
      // *mentions* are unioned with each other, which is a branch of its own.
      const x = put(f.id, {
        uid: 1304, messageId: '<x@orbit.invalid>', references: '<r1@orbit.invalid>',
        subject: 'Bridged', date: base + 60 * DAY
      })
      const bridge = put(f.id, {
        uid: 1305, references: '<r1@orbit.invalid> <r2@orbit.invalid>',
        subject: 'Bridged', date: base + 61 * DAY
      })
      const z = put(f.id, {
        uid: 1306, messageId: '<z@orbit.invalid>', references: '<r2@orbit.invalid>',
        subject: 'Bridged', date: base + 62 * DAY
      })
      regroupThreadsForAccount(account.id)
      ok('a message with no Message-ID still links the ids it references',
        threadOf(x) === threadOf(z), `${threadOf(x)} vs ${threadOf(z)}`)
      ok('while the bridging message itself keys on its subject',
        threadOf(bridge) === 'subj:bridged', String(threadOf(bridge)))

      // Two messages of one conversation sharing a timestamp. The root has to be
      // decided by something total, or it flips between runs and every cached
      // summary keyed on it is orphaned.
      const tieA = put(f.id, {
        uid: 1307, messageId: '<aaa@orbit.invalid>', subject: 'Tie', date: base + 70 * DAY
      })
      put(f.id, {
        uid: 1308, messageId: '<bbb@orbit.invalid>', references: '<aaa@orbit.invalid>',
        subject: 'Tie', date: base + 70 * DAY
      })
      regroupThreadsForAccount(account.id)
      const tieKey = threadOf(tieA)
      ok('an exact tie on date is broken by the id, not by row order',
        tieKey === 'aaa@orbit.invalid', String(tieKey))
      regroupThreadsForAccount(account.id)
      ok('and it is the same key on the next run',
        threadOf(tieA) === tieKey, String(threadOf(tieA)))
    }

    // -----------------------------------------------------------------------
    section('Zero is a value: an empty folder is not an unknown one')
    // -----------------------------------------------------------------------
    {
      // Several reads default a missing row to null or 0. Where the stored value
      // can itself be 0, `??` and `||` disagree — and `||` turns "the server has
      // no messages" into "we do not know how many", which is what decides
      // whether a folder is rebuilt from scratch.
      const f = upsertFolder(account.id, 'CONTRACT/ZERO', 'Contract Zero', 'custom')
      ok('a folder never synced has no server count yet',
        getFolderServerCount(f.id) === null, String(getFolderServerCount(f.id)))
      setFolderServerCount(f.id, 0)
      ok('and an empty mailbox reports zero, not unknown',
        getFolderServerCount(f.id) === 0, String(getFolderServerCount(f.id)))
      setFolderServerCount(f.id, 5)
      ok('a non-empty one reports its count', getFolderServerCount(f.id) === 5)

      updateFolderSyncState(f.id, { uidValidity: 0 })
      ok('a UIDVALIDITY of zero is a stored value, not a missing one',
        getFolderUidValidity(f.id) === 0, String(getFolderUidValidity(f.id)))
    }

    // -----------------------------------------------------------------------
    section('Bulk paths: nothing in, nothing done')
    // -----------------------------------------------------------------------
    {
      const f = upsertFolder(account.id, 'CONTRACT/BULK', 'Contract Bulk', 'custom')
      ok('an empty batch upsert is not a transaction',
        upsertMessagesBatch([]).length === 0)
      const written = upsertMessagesBatch([
        {
          folderId: f.id, accountId: account.id, uid: 1401, from: 'a@orbit.invalid',
          to: CONTRACT_EMAIL, subject: 'batch one', snippet: 's', date: base,
          isRead: true, isStarred: false, hasAttachments: false, bodyText: 'one'
        },
        {
          folderId: f.id, accountId: account.id, uid: 1402, from: 'a@orbit.invalid',
          to: CONTRACT_EMAIL, subject: 'batch two', snippet: 's', date: base + 1,
          isRead: true, isStarred: false, hasAttachments: false, bodyText: 'two'
        }
      ])
      ok('and a real one writes every row', written.length === 2 &&
        listMessages(f.id, 100).length === 2, `${written.length} written`)

      // The search-text backfill drains historical rows and returns how many it
      // touched, so a caller can loop until it returns nothing. Returning a
      // non-zero count with nothing left would spin that loop forever.
      while (backfillSearchTextBatch(250) > 0) { /* drain */ }
      ok('the search-text backfill reports nothing left to do',
        backfillSearchTextBatch(250) === 0)

      // Marking a folder read when it has no unread mail must not be a write —
      // it runs from a menu item the user can hold down.
      ok('marking an already-read folder read changes nothing',
        markAllMessagesReadInFolder(f.id) === 0)
      put(f.id, { uid: 1403, subject: 'batch unread', isRead: false })
      ok('and marking one with unread mail reports what it changed',
        markAllMessagesReadInFolder(f.id) === 1)
      ok('leaving the folder with none unread', countMessages(f.id, true) === 0)
    }

    // -----------------------------------------------------------------------
    section('A colour flag survives a sync that does not unstar it')
    // -----------------------------------------------------------------------
    {
      // The colour is cleared when the server says unstarred, because a colour
      // without a star is a row the UI cannot render. It must *not* be cleared
      // when the server agrees the message is starred — which is the case a
      // single unstar test walks straight past.
      const f = upsertFolder(account.id, 'CONTRACT/COLOUR', 'Contract Colour', 'custom')
      const m = put(f.id, { uid: 1501, subject: 'coloured', isRead: false })
      setMessageFlag(m, 'green')
      applyFlagUpdates(f.id, [{ uid: 1501, isRead: true, isStarred: true }])
      ok('a server update that keeps the star keeps the colour',
        getMessage(m)?.flagColor === 'green', String(getMessage(m)?.flagColor))
      applyFlagUpdates(f.id, [{ uid: 1501, isRead: true, isStarred: false }])
      ok('and only unstarring clears it', getMessage(m)?.flagColor === null)
    }

    // -----------------------------------------------------------------------
    section('An account cannot change provider by being re-saved')
    // -----------------------------------------------------------------------
    {
      // Re-saving an account is how re-authenticating works, so it must be
      // allowed. Switching provider under the same address is not: it replaces
      // credentials that cannot be recovered and silently changes how the
      // existing mail is treated.
      const resaved = saveAccount('imap', {
        authType: 'oauth', accessToken: 'contract-2', email: CONTRACT_EMAIL,
        displayName: 'DB Contract'
      })
      ok('re-saving with the same provider updates in place',
        resaved.id === account.id && getAccountTokens(account.id)?.accessToken === 'contract-2')
      let refused = false
      try {
        saveAccount('gmail', {
          authType: 'oauth', accessToken: 'x', email: CONTRACT_EMAIL, displayName: 'DB Contract'
        })
      } catch {
        refused = true
      }
      ok('and changing provider is refused rather than silently done', refused)
      ok('with the account left as it was',
        listAccounts().find((a) => a.id === account.id)?.provider === 'imap')
    }

    // -----------------------------------------------------------------------
    section('An unanalysed message has no analysis, not an empty one')
    // -----------------------------------------------------------------------
    {
      const f = upsertFolder(account.id, 'CONTRACT/AI', 'Contract Ai', 'custom')
      const m = put(f.id, { uid: 1601, subject: 'unanalysed' })
      ok('a message that was never analysed reports nothing',
        getMessageAiAnalysis(m) === null)
      ok('and neither does one that does not exist',
        getMessageAiAnalysis('no-such-message') === null)
      setMessageAiAnalysis(m, '{"summary":"x"}', base + 5000)
      ok('an analysed one reports when it was analysed',
        getMessageAiAnalysis(m)?.at === base + 5000, String(getMessageAiAnalysis(m)?.at))
    }

    // -----------------------------------------------------------------------
    section('The Drafts folder still works when it has no drafts')
    // -----------------------------------------------------------------------
    {
      // The merge is conditional, and the condition has both a true and a false
      // side. A Drafts folder holding only synced rows must list them.
      const f = upsertFolder(account.id, 'CONTRACT/DRAFTS2', 'Contract Drafts 2', 'drafts')
      put(f.id, { uid: 1701, subject: 'synced only', date: base })
      ok('a Drafts folder with no local drafts lists its synced mail',
        listMessages(f.id, 100).length === 1 && listMessages(f.id, 100)[0]!.draftId === undefined)
      ok('and so does its thread list',
        listThreads(f.id, 100).length === 1 && listThreads(f.id, 100)[0]!.draftId === undefined)
      ok('with the counts agreeing', countMessages(f.id) === 1 && countThreads(f.id) === 1)

      // The thread list has its own copy of the drafts-merge condition, and it
      // needs the same offset and unread-filter guards as the flat one.
      const draftId = saveDraft({
        accountId: account.id, to: 'x@orbit.invalid', subject: 'thread draft', bodyText: 'body'
      })
      ok('a draft appears at the top of the thread list',
        listThreads(f.id, 100)[0]?.draftId === draftId)
      ok('but not on a later page of it',
        !listThreads(f.id, 100, 1).some((t) => t.draftId === draftId))
      ok('and not under an unread filter',
        !listThreads(f.id, 100, 0, true).some((t) => t.draftId === draftId))
      deleteDraft(draftId!)
    }

    // -----------------------------------------------------------------------
    section('The unified view is not a Sent folder')
    // -----------------------------------------------------------------------
    {
      // A Sent row is about its recipient — the sender is always the account
      // owner — so a Sent thread is labelled with who it went to. `unified` is
      // inboxes, and labelling those by recipient would name the user in every
      // row of their own inbox.
      const row = listThreads('unified', 1000).find((t) => t.threadId === 'agg@orbit.invalid')
      ok('a unified conversation is labelled by who sent it',
        JSON.stringify(row?.participants) === JSON.stringify(['Ada', 'Bea']),
        JSON.stringify(row?.participants))

      // And in a real Sent folder it is the other way round.
      put(sent.id, {
        uid: 1801, messageId: '<sentthread@orbit.invalid>', subject: 'To someone',
        from: `"Me" <${CONTRACT_EMAIL}>`, to: '"Zara" <zara@orbit.invalid>',
        date: base + 80 * DAY
      })
      regroupThreadsForAccount(account.id)
      const sentRow = listThreads(sent.id, 500)
        .find((t) => t.threadId === 'sentthread@orbit.invalid')
      ok('while a Sent conversation is labelled by who it went to',
        JSON.stringify(sentRow?.participants) === JSON.stringify(['Zara']),
        JSON.stringify(sentRow?.participants))
    }

    // -----------------------------------------------------------------------
    section('A conversation with an attachment says so')
    // -----------------------------------------------------------------------
    {
      const f = upsertFolder(account.id, 'CONTRACT/ATTACH', 'Contract Attach', 'custom')
      put(f.id, {
        uid: 1901, messageId: '<att1@orbit.invalid>', subject: 'With file',
        date: base + 90 * DAY
      })
      put(f.id, {
        uid: 1902, messageId: '<att2@orbit.invalid>', references: '<att1@orbit.invalid>',
        subject: 'Re: With file', date: base + 91 * DAY
      })
      regroupThreadsForAccount(account.id)
      const rowOf = (): { hasAttachments: boolean } | undefined =>
        listThreads(f.id, 100).find((t) => t.threadId === 'att1@orbit.invalid')
      ok('a conversation with no attachments does not claim one',
        rowOf()?.hasAttachments === false)
      upsertMessage({
        folderId: f.id, accountId: account.id, uid: 1902,
        messageId: '<att2@orbit.invalid>', references: '<att1@orbit.invalid>',
        from: 'Contract Sender <sender@orbit.invalid>', to: CONTRACT_EMAIL,
        subject: 'Re: With file', snippet: 's', date: base + 91 * DAY,
        isRead: true, isStarred: false, hasAttachments: true
      })
      ok('and one where any message has one does',
        rowOf()?.hasAttachments === true)
    }

    // -----------------------------------------------------------------------
    section('A sync window of zero deletes nothing, not everything')
    // -----------------------------------------------------------------------
    {
      // "No window" and "a window of zero days" are one setting away from each
      // other and opposite in effect: the second computes a cutoff of *now* and
      // prunes the entire account. This is the guard between them, and it runs
      // unattended after a settings change.
      const f = upsertFolder(account.id, 'CONTRACT/PRUNE', 'Contract Prune', 'custom')
      put(f.id, { uid: 2001, subject: 'old mail', date: base - 400 * DAY })
      put(f.id, { uid: 2002, subject: 'recent mail', date: Date.now() })
      const before = listMessages(f.id, 100).length
      ok('a window of zero prunes nothing at all',
        pruneMessagesOutsideSyncWindow(account.id, 0) === 0 &&
          listMessages(f.id, 100).length === before,
        `${listMessages(f.id, 100).length} of ${before} left`)
      ok('and a negative one is the same', pruneMessagesOutsideSyncWindow(account.id, -1) === 0)
      // And a real window still prunes what is outside it.
      ok('while a real window drops what fell out of it',
        pruneMessagesOutsideSyncWindow(account.id, 30) >= 1 &&
          !listMessages(f.id, 100).some((m) => m.subject === 'old mail'))
      ok('and keeps what is inside it',
        listMessages(f.id, 100).some((m) => m.subject === 'recent mail'))
    }

    // -----------------------------------------------------------------------
    section('A conversation is unread only where it is unread')
    // -----------------------------------------------------------------------
    {
      // Gmail stores one row per label, so a conversation can have an unread
      // copy in a folder the user is not looking at. The row's unread dot has to
      // follow the folder on screen, or the inbox shows unread conversations
      // that are unread only in Archive.
      const key = '<scoped@orbit.invalid>'
      const inInbox = put(inbox.id, {
        uid: 2101, messageId: key, subject: 'Scoped unread',
        date: base + 100 * DAY, isRead: true
      })
      put(label.id, {
        uid: 2102, messageId: '<scoped2@orbit.invalid>', references: key,
        subject: 'Re: Scoped unread', date: base + 101 * DAY, isRead: false
      })
      regroupThreadsForAccount(account.id)
      const rowIn = (folderId: string): { hasUnread: boolean } | undefined =>
        listThreads(folderId, 500).find((t) => t.threadId === 'scoped@orbit.invalid')

      ok('the conversation is in both folders',
        rowIn(inbox.id) !== undefined && rowIn(label.id) !== undefined)
      ok('and it is unread in the folder holding the unread copy',
        rowIn(label.id)?.hasUnread === true)
      ok('but read in the folder whose copy has been read',
        rowIn(inbox.id)?.hasUnread === false, String(rowIn(inbox.id)?.hasUnread))
      // And the read/unread test itself is a test, not a truthiness check.
      setMessageRead(inInbox, false)
      ok('marking the folder\'s own copy unread lights it up',
        rowIn(inbox.id)?.hasUnread === true)
      setMessageRead(inInbox, true)
    }

    // -----------------------------------------------------------------------
    section('Two unrelated conversations must not merge through a shared gap')
    // -----------------------------------------------------------------------
    {
      // The union-find walks the ids each message *mentions*. Walking one entry
      // too far reads `undefined` off the end of the references array and unions
      // it in — and once two different messages have both unioned with the same
      // `undefined`, their conversations are one. Silent, and it merges threads
      // that have nothing to do with each other.
      const f = upsertFolder(account.id, 'CONTRACT/MERGE', 'Contract Merge', 'custom')
      const left = put(f.id, {
        uid: 2201, messageId: '<left@orbit.invalid>', references: '<p1@orbit.invalid>',
        subject: 'Left topic', date: base + 110 * DAY
      })
      put(f.id, {
        uid: 2202, references: '<p1@orbit.invalid> <p2@orbit.invalid>',
        subject: 'Left bridge', date: base + 111 * DAY
      })
      const right = put(f.id, {
        uid: 2203, messageId: '<right@orbit.invalid>', references: '<q1@orbit.invalid>',
        subject: 'Right topic', date: base + 112 * DAY
      })
      put(f.id, {
        uid: 2204, references: '<q1@orbit.invalid> <q2@orbit.invalid>',
        subject: 'Right bridge', date: base + 113 * DAY
      })
      regroupThreadsForAccount(account.id)
      ok('two conversations bridged by different absent ids stay apart',
        getMessage(left)?.threadId !== getMessage(right)?.threadId,
        `${getMessage(left)?.threadId} vs ${getMessage(right)?.threadId}`)
    }

    // -----------------------------------------------------------------------
    section('Storage usage counts the attachments that are actually on disk')
    // -----------------------------------------------------------------------
    {
      // An attachment row records a path; the file behind it may have been
      // cleaned up, moved, or never downloaded. Counting the row rather than the
      // file reports disk usage the machine does not have.
      const f = upsertFolder(account.id, 'CONTRACT/DISK', 'Contract Disk', 'custom')
      const m = put(f.id, { uid: 2301, subject: 'with attachment' })
      const beforeUsage = getAccountStorageUsage(account.id)
      addAttachment(m, 'never-fetched.pdf', 'application/pdf', 5000, null)
      ok('an attachment that was never downloaded adds no bytes',
        getAccountStorageUsage(account.id).downloadedAttachmentCount ===
          beforeUsage.downloadedAttachmentCount)
      addAttachment(m, 'gone.pdf', 'application/pdf', 5000, '/nonexistent/orbit/gone.pdf')
      ok('and neither does one whose file is no longer there',
        getAccountStorageUsage(account.id).downloadedAttachmentCount ===
          beforeUsage.downloadedAttachmentCount,
        `${getAccountStorageUsage(account.id).downloadedAttachmentCount} counted`)
      ok('while the rows themselves are still counted',
        getAccountStorageUsage(account.id).attachmentCount >= beforeUsage.attachmentCount + 2)
    }

    // -----------------------------------------------------------------------
    section('The one-time thread regroup runs once, and only once')
    // -----------------------------------------------------------------------
    {
      // Guarded by a preferences flag. Inverted, it either never runs — leaving
      // every pre-upgrade conversation split — or runs on every single start,
      // rewriting thread ids for the whole profile each time the app opens.
      const sqlite = getRawSqlite()
      const flagBefore = sqlite
        .prepare("SELECT value FROM app_preferences WHERE key = 'thread_regroup_v2'")
        .get() as { value: string } | undefined

      sqlite.prepare("DELETE FROM app_preferences WHERE key = 'thread_regroup_v2'").run()
      regroupThreadsIfNeeded()
      const flagAfter = sqlite
        .prepare("SELECT value FROM app_preferences WHERE key = 'thread_regroup_v2'")
        .get() as { value: string } | undefined
      ok('an un-run backfill runs and records that it did',
        flagAfter?.value === '1', String(flagAfter?.value))

      // Prove the guard by removing what the backfill would restore: with the
      // flag set, a deliberately wrong thread_id must survive the call.
      const f = upsertFolder(account.id, 'CONTRACT/ONCE', 'Contract Once', 'custom')
      const m = put(f.id, { uid: 2401, messageId: '<once@orbit.invalid>', subject: 'Once' })
      sqlite.prepare("UPDATE messages SET thread_id = 'deliberately-wrong' WHERE id = ?").run(m)
      regroupThreadsIfNeeded()
      ok('and a second call does not run it again',
        getMessage(m)?.threadId === 'deliberately-wrong', String(getMessage(m)?.threadId))
      regroupThreadsForAccount(account.id)
      ok('while an explicit regroup still fixes it',
        getMessage(m)?.threadId === 'once@orbit.invalid', String(getMessage(m)?.threadId))

      if (flagBefore === undefined) {
        sqlite.prepare("DELETE FROM app_preferences WHERE key = 'thread_regroup_v2'").run()
      }
    }

    // -----------------------------------------------------------------------
    section('The search-text backfill drains, and says when it is done')
    // -----------------------------------------------------------------------
    {
      // New mail gets search_text on upsert; this drains the rows synced before
      // the column existed. A caller loops until it returns 0, so reporting work
      // where there is none is an infinite loop at startup.
      const sqlite = getRawSqlite()
      const f = upsertFolder(account.id, 'CONTRACT/BACKFILL', 'Contract Backfill', 'custom')
      const m = put(f.id, { uid: 2501, subject: 'backfillable', body: 'findable body text' })
      sqlite.prepare('UPDATE messages SET search_text = NULL WHERE id = ?').run(m)

      ok('a row missing its search text is found and filled',
        backfillSearchTextBatch(250) >= 1)
      ok('and the body is searchable afterwards',
        searchMessages('findable body text', account.id).some((r) => r.id === m))
      while (backfillSearchTextBatch(250) > 0) { /* drain anything else */ }
      ok('with nothing left, it reports nothing left',
        backfillSearchTextBatch(250) === 0)
    }

    // -----------------------------------------------------------------------
    section('Contacts are collected from new mail, and only from new mail')
    // -----------------------------------------------------------------------
    {
      // Harvesting happens inside the message upsert, and it needs the account's
      // own address to tell an outgoing message from an incoming one. That
      // address is memoised — and a memo that returns nothing on a miss is
      // indistinguishable from "no account", which silently switches contact
      // collection off for the whole profile. Nothing here noticed until the
      // mutation check pointed at the cache.
      const f = upsertFolder(account.id, 'CONTRACT/CONTACTS', 'Contract Contacts', 'inbox')
      put(f.id, {
        uid: 2601, subject: 'from a person',
        from: '"Wilhelmina Quirk" <quirk@orbit.invalid>', to: CONTRACT_EMAIL
      })
      const found = suggestContacts(account.id, 'quirk')
      ok('a sender becomes a contact suggestion',
        found.some((c) => c.address === 'quirk@orbit.invalid'),
        found.map((c) => c.address).join(', '))
      ok('with the name they signed it with',
        found.find((c) => c.address === 'quirk@orbit.invalid')?.name === 'Wilhelmina Quirk',
        String(found.find((c) => c.address === 'quirk@orbit.invalid')?.name))
      // Incoming, so it counts as seen rather than written to.
      const quirk = found.find((c) => c.address === 'quirk@orbit.invalid')
      ok('and counted as someone who wrote to us',
        quirk?.seenCount === 1 && quirk?.sentCount === 0,
        `seen=${quirk?.seenCount} sent=${quirk?.sentCount}`)

      // Re-syncing a folder re-upserts every row. Counting those again would
      // inflate the ranking of whoever happens to be in a folder that resyncs.
      put(f.id, {
        uid: 2601, subject: 'from a person',
        from: '"Wilhelmina Quirk" <quirk@orbit.invalid>', to: CONTRACT_EMAIL
      })
      ok('but a re-sync of the same message does not count them twice',
        suggestContacts(account.id, 'quirk')
          .find((c) => c.address === 'quirk@orbit.invalid')?.seenCount === 1,
        String(suggestContacts(account.id, 'quirk')
          .find((c) => c.address === 'quirk@orbit.invalid')?.seenCount))

      // Outgoing mail is the stronger signal, and the account's own address is
      // never a suggestion to make to its owner.
      put(f.id, {
        uid: 2602, subject: 'to a person',
        from: `"Me" <${CONTRACT_EMAIL}>`, to: '"Ivo Prentice" <prentice@orbit.invalid>'
      })
      const ivo = suggestContacts(account.id, 'prentice')
        .find((c) => c.address === 'prentice@orbit.invalid')
      ok('a recipient of our own mail is counted as written to',
        ivo?.sentCount === 1 && ivo?.seenCount === 0,
        `seen=${ivo?.seenCount} sent=${ivo?.sentCount}`)
      ok('and the account never suggests its owner to themselves',
        !suggestContacts(account.id, 'db-contract').some((c) => c.address === CONTRACT_EMAIL))
    }

  } finally {
    // Restore the blocklist before anything else: it is global state, and
    // `test:imap` runs this beside checks that read it.
    for (const address of getBlockedSenders()) {
      if (!blockedBefore.includes(address)) unblockSender(address)
    }
    removeAccount(account.id)
  }

  // -----------------------------------------------------------------------
  section('Removing the account takes its mail with it')
  // -----------------------------------------------------------------------
  {
    ok('the account is gone', listMessages(inbox.id, 500).length === 0)
    ok('and so is everything hanging off it',
      getPop3SkippedDates(account.id).size === 0 &&
        getThread(account.id, 'a@orbit.invalid').length === 0)
  }
}
