/**
 * What went wrong when a mail server connection failed, and how to say it.
 *
 * **Nothing here imports anything at runtime**, so it is covered by
 * `npm run test:pure` and swept by `npm run test:mutants`. Keep it that way: the
 * moment it needs the DB or Electron it has to move to `test:imap`.
 *
 * The reason this exists at all is that *none* of the mail libraries put the
 * diagnosis in `err.message`:
 *
 * - ImapFlow reports a rejected LOGIN as the bare string `Command failed`, with
 *   the server's actual words on `response`.
 * - nodemailer uses `EAUTH`/`ESOCKET` codes and its own `response`.
 * - A TLS name mismatch is a `code`, with the detail buried in a long message.
 *
 * Reading `message` — the obvious thing, and what this code used to do — turned
 * a wrong password, an unreachable host and a certificate that does not cover
 * the hostname into the same three words on screen. That cost a real debugging
 * session: an account that would not sync, diagnosed only by dumping the
 * database and probing IMAP by hand, and the answer was a mistyped password.
 *
 * Classification is separated from wording because the two callers need
 * different sentences for the same fault: the Add Account dialog must say
 * *which of two servers* refused, while the status bar is already labelled with
 * the account and must not repeat it.
 */

export type ConnectionFailureKind =
  | 'auth'
  | 'certificate'
  | 'dns'
  | 'refused'
  | 'timeout'
  | 'unknown'

export interface ConnectionFailure {
  kind: ConnectionFailureKind
  /** The server's own words, tidied — or `''` when it never got that far. */
  response: string
  /** The library's own message, for when there is nothing better. */
  message: string
}

interface Errorish {
  message?: unknown
  code?: unknown
  response?: unknown
  responseText?: unknown
  authenticationFailed?: unknown
}

export function classifyConnectionFailure(err: unknown): ConnectionFailure {
  const e = (err ?? {}) as Errorish
  const code = typeof e.code === 'string' ? e.code : ''
  const message = typeof e.message === 'string' ? e.message : String(err ?? '')

  // The server's own answer, tidied: collapse folded whitespace, and drop the
  // IMAP command tag and status word — "3 NO ..." is protocol bookkeeping, not
  // information the user can act on.
  //
  // Deliberately **not** case-insensitive. `NO` and `BAD` are uppercase in the
  // protocol, while a perfectly good human sentence can begin "No such mailbox"
  // — matching that case-insensitively would serve the user "such mailbox".
  const response =
    [e.response, e.responseText]
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) =>
        v.trim().replace(/\s+/g, ' ').replace(/^(?:[A-Za-z0-9*.]+ )?(?:NO|BAD) /, '')
      )[0] ?? ''

  const kind = ((): ConnectionFailureKind => {
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || /altnames/i.test(message)) {
      return 'certificate'
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
    if (code === 'ECONNREFUSED') return 'refused'
    if (code === 'ETIMEDOUT' || /timed out|timeout/i.test(message)) return 'timeout'
    if (
      e.authenticationFailed === true ||
      code === 'EAUTH' ||
      /AUTHENTICATIONFAILED|Invalid credentials|Invalid login|LOGIN failed|\b535\b/i.test(
        `${message} ${response}`
      )
    ) {
      return 'auth'
    }
    return 'unknown'
  })()

  return { kind, response, message }
}

/**
 * Wording for the Add Account dialog and the account settings pane.
 *
 * Names the server, because two are tried and only one of them failed. Single
 * line, no newlines: it is rendered in a toast, which collapses them.
 */
export function describeConnectionFailure(
  err: unknown,
  stage: 'Incoming' | 'Outgoing',
  host: string
): Error {
  const { kind, response, message } = classifyConnectionFailure(err)
  const where = `${stage} server (${host})`

  switch (kind) {
    case 'certificate':
      return new Error(
        `${where} presented a certificate that does not cover that name, so the ` +
          `connection is not trustworthy. Use the exact server name your provider ` +
          `documents rather than one under your own domain.`
      )
    case 'dns':
      return new Error(`${where} could not be found — check the server name for a typo.`)
    case 'refused':
      return new Error(
        `${where} refused the connection — check the port and the security setting.`
      )
    case 'timeout':
      return new Error(
        `${where} did not respond — check the server name, port and security setting.`
      )
    case 'auth':
      return new Error(
        `${where} rejected the login` +
          (response ? `: ${response}. ` : '. ') +
          `Many hosts want the full email address as the username, and the mailbox ` +
          `password rather than a website or account password.`
      )
    default:
      return new Error(`${where} failed: ${response || message}`)
  }
}

/**
 * Wording for the status bar and the sidebar's per-account warning.
 *
 * **Returns the reason only, never the address.** The display layer already
 * renders `${email}: ${error}` (`syncStatus.ts`), so naming the account here
 * prints it twice.
 *
 * **The `auth` sentence must contain a word `REAUTH_PATTERN` matches**
 * (`/auth|token|login|expired|invalid_grant|consent/i`, in
 * `src/utils/syncStatus.ts`) — that regex, run over this prose, is what raises
 * the **Re-authenticate** button. Wording that reads perfectly well but happens
 * to avoid those words silently removes the user's way out. Equally, the other
 * branches must *not* match it, or a DNS typo offers a pointless re-auth. Both
 * directions are pinned in `test:store`, which runs the real strings from here
 * through the real `summarizeSyncStatus`.
 *
 * An unrecognised failure passes its message through untouched, which is what
 * preserves the already-friendly errors written elsewhere —
 * `formatGmailAuthError`, the missing-refresh-token message, and the O365 token
 * errors all arrive here as `unknown`.
 */
export function describeAccountSyncFailure(err: unknown): string {
  const { kind, response, message } = classifyConnectionFailure(err)

  switch (kind) {
    case 'certificate':
      return (
        'The mail server presented a certificate that does not cover its ' +
        'hostname. Check the server name in Settings → Accounts.'
      )
    case 'dns':
      return 'The mail server could not be found — check the server name in Settings → Accounts.'
    case 'refused':
      return 'The mail server refused the connection — check the port in Settings → Accounts.'
    case 'timeout':
      return 'The mail server did not respond.'
    case 'auth':
      // "login" is load-bearing: see the note above.
      return (
        'The mail server rejected the login' +
        (response ? ` (${response})` : '') +
        '. If the password changed, update it in Settings → Accounts.'
      )
    default:
      return message
  }
}
