import DOMPurify from 'dompurify'
import type { MessageDetail } from '../../shared/types'

// Printing renders a clean, self-contained HTML document (headers + body) and
// hands it to the main process, which loads it into an offscreen window and
// opens the OS print dialog. Building the document here means we can reuse the
// same DOMPurify sanitization the reader applies before showing email HTML.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function headerRow(label: string, value: string | null | undefined): string {
  if (!value) return ''
  return `<tr><th>${label}</th><td>${escapeHtml(value)}</td></tr>`
}

function messageSection(message: MessageDetail): string {
  const body = message.bodyHtml
    ? DOMPurify.sanitize(message.bodyHtml, {
        ADD_ATTR: ['target', 'href'],
        FORBID_TAGS: ['script', 'style']
      })
    : `<pre class="plain-body">${escapeHtml(message.bodyText ?? 'No content')}</pre>`

  return `<section class="message">
    <table class="headers">
      ${headerRow('From', message.from)}
      ${headerRow('To', message.to)}
      ${headerRow('Cc', message.cc)}
      ${headerRow('Date', new Date(message.date).toLocaleString())}
    </table>
    <div class="body">${body}</div>
  </section>`
}

const PRINT_STYLES = `
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: #1a1a1a;
    margin: 0;
    padding: 24px 32px;
    line-height: 1.5;
  }
  h1.subject {
    font-size: 20px;
    margin: 0 0 16px;
    padding-bottom: 12px;
    border-bottom: 2px solid #ddd;
  }
  .message { margin-bottom: 24px; }
  .message + .message {
    border-top: 1px solid #ddd;
    padding-top: 16px;
    page-break-before: always;
  }
  table.headers {
    border-collapse: collapse;
    margin-bottom: 12px;
    font-size: 13px;
  }
  table.headers th {
    text-align: left;
    vertical-align: top;
    color: #666;
    font-weight: 600;
    padding: 1px 12px 1px 0;
    white-space: nowrap;
  }
  table.headers td { vertical-align: top; padding: 1px 0; }
  .body { font-size: 14px; }
  .body img { max-width: 100%; height: auto; }
  .body table { max-width: 100%; }
  pre.plain-body {
    white-space: pre-wrap;
    word-wrap: break-word;
    font-family: inherit;
    margin: 0;
  }
  @page { margin: 1.5cm; }
`

function buildDocument(subject: string, sections: string): string {
  const title = subject.trim() || '(no subject)'
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${PRINT_STYLES}</style>
</head>
<body>
<h1 class="subject">${escapeHtml(title)}</h1>
${sections}
</body>
</html>`
}

/** Print a single message. */
export async function printMessageDetail(message: MessageDetail): Promise<void> {
  const html = buildDocument(message.subject, messageSection(message))
  await window.orbitMail.print.document(html)
}

/** Print a whole conversation, one message per page. */
export async function printThreadDetails(messages: MessageDetail[]): Promise<void> {
  if (messages.length === 0) return
  const subject = messages[messages.length - 1].subject
  const sections = messages.map(messageSection).join('\n')
  const html = buildDocument(subject, sections)
  await window.orbitMail.print.document(html)
}

/** Fetch a message by id and print it (used from list/menu contexts without a loaded body). */
export async function printMessageById(messageId: string): Promise<void> {
  const detail = await window.orbitMail.messages.get(messageId)
  if (!detail) throw new Error('Message not found')
  await printMessageDetail(detail)
}

/** Fetch a full conversation and print it. */
export async function printThreadById(accountId: string, threadId: string): Promise<void> {
  const messages = await window.orbitMail.messages.getThread(accountId, threadId)
  if (!messages || messages.length === 0) throw new Error('Conversation not found')
  await printThreadDetails(messages)
}
