import { safeStorage } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema'
import type { AiAnalysis, SweepResult } from '../../shared/types'
import { getRawSqlite } from '../db'
import {
  getMessage,
  listAccounts,
  getMessageAiAnalysis,
  setMessageAiAnalysis,
  listUnreadForSweep
} from './db-service'

const AI_KEY_PREF = 'ai_api_key'
const MODEL = 'claude-opus-4-8'
const MAX_BODY_CHARS = 8000
const SWEEP_MAX_MESSAGES = 40
const SWEEP_BODY_CHARS = 1500

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

const SWEEP_SYSTEM_PROMPT = `You review a batch of the user's unread emails and produce a single prioritized list of the outstanding tasks the USER needs to act on.

Rules:
- Only include tasks the USER must do. If an email is FROM the user, it is the user's own request — not a task for them.
- One email may yield zero, one, or several tasks. Skip emails that need no action (newsletters, receipts, FYIs).
- Set priority by real urgency: "urgent" for explicit deadlines/time-sensitive asks, down to "low" for optional follow-ups.
- Copy each task's sourceMessageId verbatim from the [id: ...] tag of the email it came from.
- Be specific and concise. Return an empty tasks list if nothing needs action.`

export async function sweepTasks(folderId: string | 'unified'): Promise<SweepResult | { error: string }> {
  const apiKey = getApiKey()
  if (!apiKey) {
    return { error: 'No Anthropic API key configured. Open AI settings to add one.' }
  }

  const msgs = listUnreadForSweep(folderId, SWEEP_MAX_MESSAGES)
  if (msgs.length === 0) {
    return { tasks: [], analyzedCount: 0 }
  }

  const userEmails = listAccounts().map((a) => a.email.toLowerCase())
  const meta = new Map(msgs.map((m) => [m.id, { subject: m.subject, from: m.from }]))

  const blocks = msgs.map((m) => {
    const fromLower = m.from.toLowerCase()
    const isFromUser = userEmails.some((email) => email.length > 0 && fromLower.includes(email))
    let body = m.bodyText ?? (m.bodyHtml ? stripHtml(m.bodyHtml) : '')
    if (body.length > SWEEP_BODY_CHARS) body = body.slice(0, SWEEP_BODY_CHARS) + '… [truncated]'
    return `[id: ${m.id}] ${isFromUser ? 'FROM YOU' : 'TO YOU'}
From: ${m.from}
Subject: ${m.subject}
Date: ${new Date(m.date).toISOString()}
${body || '(no body content)'}`
  })

  const userPrompt = `Review these ${msgs.length} unread emails and extract the outstanding tasks I need to act on.\n\n${blocks.join('\n\n---\n\n')}`

  const client = new Anthropic({ apiKey })

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

    // Enrich with the real subject/sender, dropping any hallucinated source id.
    const tasks = parsed.tasks
      .filter((t) => meta.has(t.sourceMessageId))
      .map((t) => {
        const source = meta.get(t.sourceMessageId)!
        return {
          task: t.task,
          priority: t.priority,
          sourceMessageId: t.sourceMessageId,
          sourceSubject: source.subject,
          sourceFrom: source.from
        }
      })

    return { tasks, analyzedCount: msgs.length }
  } catch (err) {
    return { error: friendlyError(err) }
  }
}
