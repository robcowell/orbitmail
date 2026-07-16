# SMTP send (`:smtp:send`)

Port of the **send half** of the desktop `electron/services/smtp-send.ts`. The
reply/forward *payload* half of that file (attribution, quote, References chain,
reply-all dedup) is pure UI logic and already lives in `:ui:presentation`
(`ReplyComposer`); this module is only the transport + MIME + submission.

## Surface

- `SmtpAuth` — `XOAuth2(email, accessToken)` | `Password(username, password)`.
- `SmtpAccount(host, port, fromAddress, auth, useStartTls = true)`.
- `OutgoingMessage(to, cc?, bcc?, subject, bodyText?, bodyHtml?, inReplyTo?, references?, userAgent?)`.
- `SmtpSender.send(account, message): ByteArray` — builds the `MimeMessage`,
  submits it, and returns the raw RFC 822 bytes (so the caller can APPEND to the
  server Sent folder). Blocking Jakarta Mail — call on an IO dispatcher.

## Design notes

- **XOAUTH2 mirrors the IMAP factory** (`mail.smtp.auth.mechanisms=XOAUTH2`, OAuth
  access token supplied as the connect password), so the Step 3 token flows
  straight through — the same mechanism the IMAP spike proved.
- **STARTTLS on 587** for real providers; GreenMail tests use plain SMTP
  (`useStartTls = false`).
- **Body**: text-only → `text/plain`; html present → `multipart/alternative`
  (plain part first, html last, per RFC 2046 §5.1.4).
- **Threading**: `In-Reply-To` / `References` are set verbatim from the draft so
  replies group under the original conversation on the recipient side.
- **Jakarta Mail is `compileOnly`** (+ `testImplementation`): on Android the app
  provides `com.sun.mail:android-mail` (identical `javax.mail` API); exporting
  `jakarta.mail` from here would collide with it (duplicate classes).

## Verified (JVM, `gradle -p smtp/send test`)

5 tests against a **real GreenMail SMTP** server, nothing mocked: plain-text
delivery (subject + body), threading + mailer headers (`In-Reply-To`,
`References`, `User-Agent`, `X-Mailer`), `multipart/alternative` for html,
to/cc/bcc envelope fan-out, and the raw-RFC-822 return.

The `Password` path is exercised end-to-end; **XOAUTH2 is config-only** and
matches the proven IMAP mechanism — a real-account run is a Layer-3 handoff.

## Wiring (`AppGraph.sendMail`)

Resolves the stored `AccountEntity` → `SmtpAccount` (provider endpoint +
`XOAuth2(email, authenticator.freshAccessToken(id))`) and the `ComposeDraft` →
`OutgoingMessage` (merging the user's body with the collapsed reply quote), then
sends on `Dispatchers.IO`. Wired for OAuth (Gmail/O365) accounts.

## Deferred

- **Append-to-Sent** — `send()` already returns the raw bytes; needs an IMAP
  APPEND on `:sync:engine` (the desktop `appendToSentFolder`).
- **Manual (IMAP/POP3) SMTP** — blocked on Android manual-credential storage
  (no password store yet; only OAuth tokens are persisted).
- **Attachments** — the Android `ComposeDraft` has no attachment field yet.
