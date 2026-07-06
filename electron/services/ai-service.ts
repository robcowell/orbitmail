import { safeStorage } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema'
import type {
  AiAnalysis,
  AiPriority,
  DraftTone,
  ReplyDraft,
  SweepResult,
  SweepScope,
  SweepTask
} from '../../shared/types'
import { getRawSqlite } from '../db'
import {
  getMessage,
  listAccounts,
  listThreadMessages,
  getMessageAiAnalysis,
  setMessageAiAnalysis,
  setMessageSweepCache,
  listMessagesForSweep,
  listOpenSweepTasks,
  listCompletedSweepTasks,
  replaceOpenSweepTasks,
  completeSweepTask,
  reopenSweepTask,
  pruneCompletedSweepTasks,
  getSweepMeta,
  setSweepMeta,
  type SweepMessage
} from './db-service'

const AI_KEY_PREF = 'ai_api_key'
const MODEL = 'claude-opus-4-8'
const MAX_BODY_CHARS = 8000
const SWEEP_MAX_MESSAGES = 40
const SWEEP_BODY_CHARS = 1500
// Completed tasks older than this are pruned and no longer fed back to the model.
const COMPLETED_TASK_TTL_MS = 30 * 24 * 60 * 60 * 1000
// How many recent completed tasks to show the model as "already done".
const COMPLETED_CONTEXT_LIMIT = 25

// ---------------------------------------------------------------------------
// API key storage (encrypted at rest via Electron safeStorage, mirrors the
// account-credentials.ts pattern). Stored in its own app_preferences row so the
// secret never travels over the renderer-facing `app_state` blob.
// ---------------------------------------------------------------------------

function encrypt(plaintext: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plaintext).toString('base64')
  }
  return Buffer.from(plaintext).toString('base64')
}

function decrypt(blob: string): string {
  const raw = Buffer.from(blob, 'base64')
  return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
}

function readEncryptedKey(): string | null {
  const row = getRawSqlite()
    .prepare('SELECT value FROM app_preferences WHERE key = ?')
    .get(AI_KEY_PREF) as { value: string } | undefined
  return row?.value ?? null
}

export function setApiKey(plaintext: string): void {
  const trimmed = plaintext.trim()
  if (!trimmed) {
    clearApiKey()
    return
  }
  getRawSqlite()
    .prepare(
      'INSERT INTO app_preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(AI_KEY_PREF, encrypt(trimmed))
}

export function clearApiKey(): void {
  getRawSqlite().prepare('DELETE FROM app_preferences WHERE key = ?').run(AI_KEY_PREF)
}

function getApiKey(): string | null {
  const blob = readEncryptedKey()
  if (!blob) return null
  try {
    return decrypt(blob)
  } catch {
    return null
  }
}

export function isConfigured(): boolean {
  return getApiKey() !== null
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'A one or two sentence plain-language summary of the email.'
    },
    actionItems: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific things the user needs to do. Empty if none.'
    },
    questions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Open questions the user needs to answer or information requested of them.'
    },
    keyContext: {
      type: 'array',
      items: { type: 'string' },
      description: 'Important decisions, deadlines, or facts worth remembering.'
    }
  },
  required: ['summary', 'actionItems', 'questions', 'keyContext'],
  additionalProperties: false
} as const

const SYSTEM_PROMPT = `You are an expert assistant that analyzes a single email and tells the user what they need to do about it.

CRITICAL: Pay close attention to who sent the message.
- If the email is FROM the user, the user is the one making a request or asking for something — that is NOT an action for the user to complete.
- If the email is TO the user (from someone else), that person is making a request of the user — that IS an action for the user.
Only put things the USER needs to do in actionItems.

Be specific and actionable. Do not invent deadlines or facts that aren't in the email. Leave a list empty rather than padding it with generic filler.`

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function friendlyError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Authentication failed. Check your Anthropic API key in AI settings.'
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return 'Your API key does not have permission to use this model.'
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Rate limit exceeded. Please wait a moment and try again.'
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the Anthropic API. Check your connection.'
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error: ${err.message}`
  }
  return `Analysis failed: ${err instanceof Error ? err.message : String(err)}`
}

export async function analyzeMessage(
  messageId: string,
  options: { force?: boolean } = {}
): Promise<AiAnalysis | { error: string }> {
  if (!options.force) {
    const cached = getMessageAiAnalysis(messageId)
    if (cached) {
      try {
        return { ...(JSON.parse(cached.json) as Omit<AiAnalysis, 'generatedAt' | 'cached'>), generatedAt: cached.at, cached: true }
      } catch {
        // fall through and regenerate on malformed cache
      }
    }
  }

  const apiKey = getApiKey()
  if (!apiKey) {
    return { error: 'No Anthropic API key configured. Open AI settings to add one.' }
  }

  const message = getMessage(messageId)
  if (!message) {
    return { error: 'Message not found.' }
  }

  const userEmails = listAccounts().map((a) => a.email.toLowerCase())
  const fromLower = message.from.toLowerCase()
  const isFromUser = userEmails.some((email) => email.length > 0 && fromLower.includes(email))

  let body = message.bodyText ?? (message.bodyHtml ? stripHtml(message.bodyHtml) : '')
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS) + '\n... [truncated]'
  }

  const senderLine = isFromUser
    ? 'Sender: this email is FROM THE USER — the user is making a request or asking for something.'
    : 'Sender: this email is TO THE USER — someone else is making a request of the user.'

  const userPrompt = `Analyze this email and return the structured analysis.

${senderLine}
From: ${message.from}
To: ${message.to}
Date: ${new Date(message.date).toISOString()}
Subject: ${message.subject}

Body:
${body || '(no body content)'}`

  const client = new Anthropic({ apiKey })

  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 2048,
      output_config: {
        effort: 'low',
        format: jsonSchemaOutputFormat(ANALYSIS_SCHEMA)
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    })

    if (response.stop_reason === 'refusal') {
      return { error: 'The model declined to analyze this message.' }
    }

    const parsed = response.parsed_output
    if (!parsed) {
      return { error: 'The model returned no usable analysis. Try again.' }
    }

    const generatedAt = Date.now()
    const stored = {
      summary: parsed.summary,
      actionItems: parsed.actionItems,
      questions: parsed.questions,
      keyContext: parsed.keyContext
    }
    setMessageAiAnalysis(messageId, JSON.stringify(stored), generatedAt)

    return { ...stored, generatedAt, cached: false }
  } catch (err) {
    return { error: friendlyError(err) }
  }
}

// ---------------------------------------------------------------------------
// Reply drafting — generate an editable reply body grounded in the conversation.
// ---------------------------------------------------------------------------

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    reply: {
      type: 'string',
      description:
        'The reply body text, ready to send, written in the first person as the user. Plain text with paragraph breaks; no subject line, no To/From headers, no quoted original.'
    }
  },
  required: ['reply'],
  additionalProperties: false
} as const

const TONE_GUIDANCE: Record<DraftTone, string> = {
  brief: 'Keep it short — 2 to 4 sentences. Direct and to the point; no preamble.',
  neutral: 'Use a normal, professional length and tone — a few short paragraphs at most.',
  detailed:
    'Be thorough: address each question and request in the conversation, point by point, while staying clear and well-organized.'
}

const MAX_THREAD_MESSAGES = 12
const DRAFT_BODY_CHARS = 4000

function draftSystemPrompt(userName: string, tone: DraftTone): string {
  return `You draft an email reply on behalf of ${userName}. Write ONLY the reply body, in the first person as ${userName}, ready to paste into the composer.

Rules:
- No subject line, no "To:"/"From:" headers, and do NOT quote or restate the original message — the composer keeps the quoted thread separately.
- Match the conversation's tone and language. Answer any questions asked of the user and acknowledge or address any requests made of them.
- Do NOT invent facts, commitments, dates, numbers, or names that aren't supported by the thread. If something needs the user's input, leave a natural placeholder in [square brackets].
- End with a simple, natural sign-off (e.g. the user's first name). Do not add a full signature block.
- ${TONE_GUIDANCE[tone]}`
}

function threadBlock(
  m: { from: string; subject: string; date: number; bodyText: string | null; bodyHtml: string | null },
  isFromUser: boolean
): string {
  let body = m.bodyText ?? (m.bodyHtml ? stripHtml(m.bodyHtml) : '')
  if (body.length > DRAFT_BODY_CHARS) body = body.slice(0, DRAFT_BODY_CHARS) + '… [truncated]'
  return `${isFromUser ? 'FROM YOU' : 'FROM ' + m.from} — ${new Date(m.date).toISOString()}
Subject: ${m.subject}
${body || '(no body content)'}`
}

export async function draftReply(
  messageId: string,
  options: { tone?: DraftTone; mode?: 'reply' | 'reply-all' } = {}
): Promise<ReplyDraft | { error: string }> {
  const apiKey = getApiKey()
  if (!apiKey) {
    return { error: 'No Anthropic API key configured. Open AI settings to add one.' }
  }

  const message = getMessage(messageId)
  if (!message) {
    return { error: 'Message not found.' }
  }

  const tone: DraftTone = options.tone ?? 'neutral'
  const accounts = listAccounts()
  const account = accounts.find((a) => a.id === message.accountId)
  const userName = account?.displayName?.trim() || account?.email || 'the user'
  const userEmails = accounts.map((a) => a.email.toLowerCase())
  const isFromUser = (from: string): boolean => {
    const fromLower = from.toLowerCase()
    return userEmails.some((email) => email.length > 0 && fromLower.includes(email))
  }

  // Ground the draft in the whole conversation when we can (Sent replies
  // included); otherwise just the message being replied to.
  const thread =
    message.threadId && message.threadId.length > 0
      ? listThreadMessages(message.accountId, message.threadId, MAX_THREAD_MESSAGES)
      : []
  const context = thread.length > 0 ? thread : [message]
  const blocks = context.map((m) => threadBlock(m, isFromUser(m.from)))

  const userPrompt = `Draft my reply to the most recent message in this email conversation (oldest to newest below). I am ${userName}. Write the reply I should send.

${blocks.join('\n\n---\n\n')}`

  const client = new Anthropic({ apiKey })

  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 2048,
      output_config: {
        effort: 'low',
        format: jsonSchemaOutputFormat(DRAFT_SCHEMA)
      },
      system: draftSystemPrompt(userName, tone),
      messages: [{ role: 'user', content: userPrompt }]
    })

    if (response.stop_reason === 'refusal') {
      return { error: 'The model declined to draft a reply for this message.' }
    }

    const parsed = response.parsed_output
    if (!parsed || !parsed.reply.trim()) {
      return { error: 'The model returned an empty draft. Try again.' }
    }

    return { bodyText: parsed.reply.trim() }
  } catch (err) {
    return { error: friendlyError(err) }
  }
}

// ---------------------------------------------------------------------------
// Inbox sweep — one batched call over unread messages in a folder, returning a
// prioritized list of outstanding tasks the user needs to act on.
// ---------------------------------------------------------------------------

const SWEEP_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'A specific outstanding action the user needs to take.'
          },
          priority: {
            type: 'string',
            enum: ['urgent', 'high', 'medium', 'low'],
            description: 'How urgently this needs attention.'
          },
          sourceMessageId: {
            type: 'string',
            description: 'The exact id of the email this task came from, copied verbatim.'
          }
        },
        required: ['task', 'priority', 'sourceMessageId'],
        additionalProperties: false
      }
    }
  },
  required: ['tasks'],
  additionalProperties: false
} as const

const SWEEP_SYSTEM_PROMPT = `You review a batch of the user's emails and produce a single prioritized list of the outstanding tasks the USER needs to act on.

Rules:
- Only include tasks the USER must do. If an email is FROM the user, it is the user's own request — not a task for them.
- One email may yield zero, one, or several tasks. Skip emails that need no action (newsletters, receipts, FYIs).
- Set priority by real urgency: "urgent" for explicit deadlines/time-sensitive asks, down to "low" for optional follow-ups.
- Copy each task's sourceMessageId verbatim from the [id: ...] tag of the email it came from.
- If an "Already completed" list is provided, the user has already handled those items — do NOT list them again, even if the email still looks unaddressed.
- Be specific and concise. Return an empty tasks list if nothing needs action.`

// A single message's cached sweep extraction.
interface CachedTask {
  task: string
  priority: AiPriority
}

const VALID_PRIORITIES: ReadonlySet<string> = new Set(['urgent', 'high', 'medium', 'low'])

function parseSweepCache(json: string | null): CachedTask[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (t): t is CachedTask =>
        t && typeof t.task === 'string' && VALID_PRIORITIES.has(t.priority)
    )
  } catch {
    return []
  }
}

// Render one message as a prompt block tagged with its id so the model can cite
// the source it came from.
function messageBlock(m: SweepMessage, isFromUser: boolean): string {
  let body = m.bodyText ?? (m.bodyHtml ? stripHtml(m.bodyHtml) : '')
  if (body.length > SWEEP_BODY_CHARS) body = body.slice(0, SWEEP_BODY_CHARS) + '… [truncated]'
  return `[id: ${m.id}] ${isFromUser ? 'FROM YOU' : 'TO YOU'}
From: ${m.from}
Subject: ${m.subject}
Date: ${new Date(m.date).toISOString()}
${body || '(no body content)'}`
}

// Stable dedupe key for a task: its source message plus a normalized form of the
// task text. Lets us recognize the "same" task across sweeps so completed work
// does not resurface.
function taskDedupeKey(sourceMessageId: string, task: string): string {
  const normalized = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 120)
  return `${sourceMessageId}::${normalized}`
}

export async function sweepTasks(
  folderId: string | 'unified',
  scope: SweepScope = 'unread'
): Promise<SweepResult | { error: string }> {
  const apiKey = getApiKey()
  if (!apiKey) {
    return { error: 'No Anthropic API key configured. Open AI settings to add one.' }
  }

  // Age out stale history before we read it back for context.
  pruneCompletedSweepTasks(Date.now() - COMPLETED_TASK_TTL_MS)
  const completed = listCompletedSweepTasks(folderId)
  const completedKeys = new Set(completed.map((t) => t.id))

  const msgs = listMessagesForSweep(folderId, scope, SWEEP_MAX_MESSAGES)
  if (msgs.length === 0) {
    const sweptAt = Date.now()
    replaceOpenSweepTasks(folderId, [], sweptAt)
    setSweepMeta(folderId, { analyzedCount: 0, sweptAt, scope })
    return { tasks: [], completed, analyzedCount: 0, freshCount: 0, scope, sweptAt }
  }

  const userEmails = listAccounts().map((a) => a.email.toLowerCase())
  const isFromUser = (from: string): boolean => {
    const fromLower = from.toLowerCase()
    return userEmails.some((email) => email.length > 0 && fromLower.includes(email))
  }

  // Incremental sweep: only messages we've never analyzed need an API call.
  // Everything else reuses its cached per-message extraction, so a re-sweep of
  // an unchanged inbox spends zero tokens.
  const uncached = msgs.filter((m) => m.sweepCache === null)
  const extracted = new Map<string, CachedTask[]>()

  if (uncached.length > 0) {
    const blocks = uncached.map((m) => messageBlock(m, isFromUser(m.from)))
    const scopeLabel = scope === 'all' ? 'emails' : 'unread emails'
    let userPrompt = `Review these ${uncached.length} ${scopeLabel} and extract the outstanding tasks I need to act on.\n\n${blocks.join('\n\n---\n\n')}`

    // Give the model the tasks the user has already ticked off so it won't
    // resurface them. Capped to the most recent handful to keep the prompt lean.
    if (completed.length > 0) {
      const done = completed
        .slice(0, COMPLETED_CONTEXT_LIMIT)
        .map((t) => `- ${t.task} (re: ${t.sourceSubject})`)
        .join('\n')
      userPrompt += `\n\n---\n\nAlready completed — do NOT list these again:\n${done}`
    }

    const client = new Anthropic({ apiKey })
    const allowedIds = new Set(uncached.map((m) => m.id))

    try {
      const response = await client.messages.parse({
        model: MODEL,
        max_tokens: 4096,
        output_config: {
          effort: 'low',
          format: jsonSchemaOutputFormat(SWEEP_SCHEMA)
        },
        system: SWEEP_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }]
      })

      if (response.stop_reason === 'refusal') {
        return { error: 'The model declined to analyze these messages.' }
      }

      const parsed = response.parsed_output
      if (!parsed) {
        return { error: 'The model returned no usable tasks. Try again.' }
      }

      // Seed every analyzed message with an empty list so "no tasks" is cached
      // too — otherwise it would be re-sent on every future sweep.
      for (const m of uncached) extracted.set(m.id, [])
      for (const t of parsed.tasks) {
        const list = extracted.get(t.sourceMessageId)
        if (!list) continue // hallucinated id or a message not in this batch
        list.push({ task: t.task, priority: t.priority })
      }

      const at = Date.now()
      for (const m of uncached) {
        if (!allowedIds.has(m.id)) continue
        setMessageSweepCache(m.id, JSON.stringify(extracted.get(m.id) ?? []), at)
      }
    } catch (err) {
      return { error: friendlyError(err) }
    }
  }

  // Merge freshly-extracted and cached tasks into the final list. Enrich with the
  // real subject/sender, assign a stable dedupe id, drop anything already
  // completed, and de-dupe.
  const seen = new Set<string>()
  const tasks: SweepTask[] = []
  for (const m of msgs) {
    const list = extracted.get(m.id) ?? parseSweepCache(m.sweepCache)
    for (const t of list) {
      const id = taskDedupeKey(m.id, t.task)
      if (completedKeys.has(id) || seen.has(id)) continue
      seen.add(id)
      tasks.push({
        id,
        task: t.task,
        priority: t.priority,
        sourceMessageId: m.id,
        sourceSubject: m.subject,
        sourceFrom: m.from
      })
    }
  }

  const sweptAt = Date.now()
  replaceOpenSweepTasks(folderId, tasks, sweptAt)
  setSweepMeta(folderId, { analyzedCount: msgs.length, sweptAt, scope })

  return {
    tasks,
    completed,
    analyzedCount: msgs.length,
    freshCount: uncached.length,
    scope,
    sweptAt
  }
}

// Persisted view — the last sweep's open tasks plus completed history, with no
// API call. Used when the Tasks dialog opens so we don't re-spend tokens.
export function getPersistedTasks(folderId: string | 'unified'): SweepResult {
  pruneCompletedSweepTasks(Date.now() - COMPLETED_TASK_TTL_MS)
  const meta = getSweepMeta(folderId)
  return {
    tasks: listOpenSweepTasks(folderId),
    completed: listCompletedSweepTasks(folderId),
    analyzedCount: meta?.analyzedCount ?? 0,
    freshCount: 0,
    scope: meta?.scope ?? 'unread',
    sweptAt: meta?.sweptAt ?? null
  }
}

export function completeTask(folderId: string | 'unified', taskId: string): void {
  completeSweepTask(folderId, taskId, Date.now())
}

export function reopenTask(folderId: string | 'unified', taskId: string): void {
  reopenSweepTask(folderId, taskId)
}
