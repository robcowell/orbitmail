// What to do about an exception nobody caught.
//
// The handler existed to swallow one specific nuisance — IMAP sockets that time
// out and surface as an uncaught error rather than a rejected promise — but it
// swallowed *everything*, logging to a console the user never sees and carrying
// on. After an uncaught exception the process state is unknown by definition:
// a sync may have stopped half way, a connection lane may still be held. The
// app carrying on as though nothing happened is a guess, and a silent one.
//
// Killing the app instead would be worse for a mail client: a stray error in a
// background timer would take the user's session with it. So: keep the narrow
// suppression, and for anything else tell the user, once, that a restart is
// wise — then let them choose when.

/**
 * IMAP sockets time out during normal operation, and imapflow surfaces some of
 * those as uncaught errors. They are noise, not news: the pool reconnects.
 */
export function isBenignSocketError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = 'code' in err ? String((err as { code?: unknown }).code) : ''
  if (code === 'ETIMEOUT' || code === 'ETIMEDOUT') return true
  const message = 'message' in err ? String((err as { message?: unknown }).message) : ''
  return message === 'Socket timeout'
}

/** One line for the user: what happened, and what it means for them. */
export function describeUnexpectedError(err: unknown): string {
  const message =
    err && typeof err === 'object' && 'message' in err
      ? String((err as { message?: unknown }).message)
      : String(err)
  const trimmed = message.trim().slice(0, 200)
  return trimmed.length > 0
    ? `Orbit Mail hit an unexpected error (${trimmed}). Mail is safe, but restart when convenient.`
    : 'Orbit Mail hit an unexpected error. Mail is safe, but restart when convenient.'
}
