/**
 * Did a failed sync attempt actually reach the mail server?
 *
 * This is the evidence the "offline" banner is built from. `navigator.onLine`
 * cannot answer it: Chromium reports whether a network interface exists, not
 * whether anything is reachable over it, so a hotel captive portal, a dropped
 * VPN, a DNS outage or a server refusing connections all read as *online* and
 * the app shows stale mail as though it were current.
 *
 * The distinction that matters is **reached but refused** versus **never
 * reached**. An expired token is not an outage — the server answered, and
 * telling the user they are offline sends them to fix their wifi instead of
 * their credentials. Only a connection that never landed is evidence of one.
 */

/**
 * Connection-level failures: the socket never carried a conversation. Kept
 * deliberately narrow — anything not listed is treated as "reached", because
 * the cost of wrongly claiming an outage (sending someone to debug a working
 * network) is higher than the cost of missing one (the mail is simply stale,
 * which the per-account status already says).
 */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', // nothing listening on the port
  'ENOTFOUND', // DNS returned nothing
  'EAI_AGAIN', // DNS resolver itself is unreachable
  'EHOSTUNREACH', // no route to the host
  'ENETUNREACH', // no route at all — the classic dropped-VPN shape
  'ETIMEDOUT', // SYN went unanswered
  'ETIMEOUT', // imapflow's spelling of the same thing
  'ECONNABORTED',
  'EHOSTDOWN',
  'ENETDOWN',
  'EPROTO' // TLS refused outright, e.g. a captive portal intercepting 993
])

/**
 * Message shapes for the same failures where no `code` survives. Several layers
 * here (imapflow, node-pop3, nodemailer) rethrow as plain Errors, so the code is
 * often gone by the time it reaches sync.
 */
const UNREACHABLE_PATTERNS = [
  /\bECONNREFUSED\b/i,
  /\bENOTFOUND\b/i,
  /\bEAI_AGAIN\b/i,
  /\bEHOSTUNREACH\b/i,
  /\bENETUNREACH\b/i,
  /\bETIMEDOUT?\b/i,
  /getaddrinfo/i,
  /socket hang up/i,
  /failed to connect/i,
  /network is unreachable/i,
  // Bare timeout wording, which is what imapflow and node-pop3 actually emit
  // ("Command failed: Timeout", "Timed out while connecting"). Listing only the
  // qualified forms — "socket timeout", "connection timeout" — missed every one
  // of them, so a genuine outage read as "reached" and no banner appeared.
  // This is also what makes the authentication guard above load-bearing: an
  // auth failure phrased as a login timeout matches here and must not win.
  /\btimed[- ]?out\b/i,
  /\btimeout\b/i
]

function errorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return ''
  if ('code' in err) return String((err as { code?: unknown }).code ?? '')
  return ''
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message?: unknown }).message ?? '')
  }
  return typeof err === 'string' ? err : ''
}

/** True when the failure means we never got a conversation with the server. */
export function isUnreachableError(err: unknown): boolean {
  const code = errorCode(err)
  if (code && UNREACHABLE_CODES.has(code.toUpperCase())) return true

  const message = errorMessage(err)
  if (!message) return false

  // An authentication failure can carry a hostname and a timeout-ish word in
  // the same sentence; being refused *is* being reached, so it wins outright.
  if (/authenticat|invalid_grant|credential|password|\bAUTHENTICATIONFAILED\b|\blogin\b/i.test(message)) {
    return false
  }

  return UNREACHABLE_PATTERNS.some((p) => p.test(message))
}

/**
 * What to record on an account after an attempt: `true` when the server
 * answered at all — including when it answered "no".
 */
export function reachedServer(err: unknown): boolean {
  return !isUnreachableError(err)
}
