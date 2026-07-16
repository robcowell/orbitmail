import DOMPurify from 'dompurify'
import type { AiAnalysis, MessageDetail } from '../../shared/types'

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function attachmentsSection(message: MessageDetail): string {
  if (message.attachments.length === 0) return ''
  const items = message.attachments
    .map(
      (att) =>
        `<li>${escapeHtml(att.filename)} <span class="att-size">(${formatSize(att.size)})</span></li>`
    )
    .join('')
  const label = message.attachments.length === 1 ? 'Attachment' : 'Attachments'
  return `<div class="attachments"><span class="att-label">${label}:</span><ul>${items}</ul></div>`
}

// The AI summary block (summary + action items). Rendered only when the caller
// opts in and an analysis exists for the message.
function aiSummarySection(analysis: AiAnalysis): string {
  const actionItems = analysis.actionItems.length
    ? `<div class="ai-subhead">Action Items</div><ul class="ai-actions">${analysis.actionItems
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join('')}</ul>`
    : ''
  return `<section class="ai-summary">
    <div class="ai-head">AI Summary</div>
    <p class="ai-body">${escapeHtml(analysis.summary)}</p>
    ${actionItems}
  </section>`
}

function messageSection(message: MessageDetail, aiAnalysis?: AiAnalysis): string {
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
    ${attachmentsSection(message)}
    ${aiAnalysis ? aiSummarySection(aiAnalysis) : ''}
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
  .attachments {
    font-size: 13px;
    margin-bottom: 12px;
    padding: 8px 12px;
    background: #f5f5f5;
    border: 1px solid #ddd;
    border-radius: 4px;
  }
  .attachments .att-label { font-weight: 600; color: #666; }
  .attachments ul { margin: 4px 0 0; padding-left: 20px; }
  .attachments li { margin: 1px 0; }
  .attachments .att-size { color: #888; }
  .ai-summary {
    font-size: 13px;
    margin-bottom: 16px;
    padding: 10px 14px;
    background: #f0f4ff;
    border: 1px solid #c7d4f5;
    border-radius: 4px;
    page-break-inside: avoid;
  }
  .ai-summary .ai-head {
    font-weight: 700;
    color: #3355bb;
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    font-size: 11px;
  }
  .ai-summary .ai-body { margin: 0; }
  .ai-summary .ai-subhead {
    font-weight: 600;
    color: #555;
    margin: 8px 0 2px;
  }
  .ai-summary ul.ai-actions { margin: 2px 0 0; padding-left: 20px; }
  .ai-summary ul.ai-actions li { margin: 1px 0; }
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

/** Print a single message, optionally including its AI summary. */
export async function printMessageDetail(
  message: MessageDetail,
  aiAnalysis?: AiAnalysis
): Promise<void> {
  const html = buildDocument(message.subject, messageSection(message, aiAnalysis))
  await window.orbitMail.print.document(html)
}

/** Print a whole conversation, one message per page. */
export async function printThreadDetails(messages: MessageDetail[]): Promise<void> {
  if (messages.length === 0) return
  const subject = messages[messages.length - 1].subject
  const sections = messages.map((m) => messageSection(m)).join('\n')
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
