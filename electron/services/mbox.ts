// mbox writing.
//
// An mbox file is messages concatenated with a `From ` line between them, which
// means any line inside a message that itself begins `From ` would be read as
// the start of the next message. Writing one without escaping those produces a
// file that looks fine and silently splits messages in every reader that opens
// it — including when you try to import it back.
//
// Everything here works in `Buffer`s. Message sources are bytes, and not
// necessarily UTF-8: a body in ISO-8859-1, or a header with a raw 8-bit byte,
// becomes mojibake the moment it is decoded as UTF-8 and re-encoded. `latin1`
// is used for line scanning precisely because it maps bytes 1:1 to code points
// and back, so the bytes that come out are the bytes that went in.

const LF = 0x0a

/**
 * Escape `From ` lines, mboxrd style: any line of the form `>*From ` gains one
 * more `>`.
 *
 * mboxrd rather than mboxo because it is reversible — a reader can strip
 * exactly one `>` and get the original back. mboxo escapes only a bare `From `,
 * so a body that legitimately contains `>From ` is indistinguishable from an
 * escaped one and cannot be restored.
 */
export function escapeMboxBody(source: Buffer): Buffer {
  const text = source.toString('latin1')
  const escaped = text.replace(/(^|\n)(>*From )/g, (_match, start: string, marker: string) => {
    return `${start}>${marker}`
  })
  return Buffer.from(escaped, 'latin1')
}

/** Two-digit pad for the asctime-style date in a `From ` line. */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
]

/**
 * The separator line. The date is asctime — `Thu Jul 23 15:04:05 2026` — which
 * is what the format specifies; `toUTCString()` produces commas and a timezone
 * that some readers reject.
 */
export function mboxFromLine(date: Date): string {
  const d = Number.isNaN(date.getTime()) ? new Date(0) : date
  const stamp =
    `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ` +
    `${d.getUTCFullYear()}`
  return `From MAILER-DAEMON ${stamp}\n`
}

/**
 * One message, ready to append: separator, escaped source, and the blank line
 * that ends an entry. Returned as a Buffer so a caller can stream it straight
 * to disk without ever holding the whole mailbox as a string.
 */
export function mboxEntry(source: Buffer, date: Date): Buffer {
  const body = escapeMboxBody(source)
  const needsNewline = body.length > 0 && body[body.length - 1] !== LF
  return Buffer.concat([
    Buffer.from(mboxFromLine(date), 'latin1'),
    body,
    needsNewline ? Buffer.from('\n', 'latin1') : Buffer.alloc(0),
    Buffer.from('\n', 'latin1')
  ])
}
