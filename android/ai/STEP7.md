# AI Features (Plan Step 7)

Ports the desktop's Anthropic integration (`ai-service.ts`, audit §7) — Analyze,
Draft reply, Tasks sweep — to a Kotlin OkHttp client. Unlike Steps 2/3/5/6, most
of this is **buildable and tested here**: OkHttp + org.json run on the JVM, so the
whole thing compiles and runs; only a real API call needs a user key (gated).

## API shape (verified against the claude-api skill)

- **Model** `claude-opus-4-8` · endpoint `POST /v1/messages` · header
  `anthropic-version: 2023-06-01`.
- **Structured outputs** via `output_config.format = {type:"json_schema", schema}`
  with `output_config.effort = "low"` — every schema object is
  `additionalProperties:false` + `required` (the structured-output contract).
- **Refusal handling** — safety classifiers can return HTTP 200 with
  `stop_reason:"refusal"`; checked before reading content.
- **Why OkHttp, not the Anthropic Java SDK:** the audit (§7) chose a REST client
  for on-device calls — lighter than the Java SDK on Android, and OkHttp/org.json
  are Android-native. The API shape follows the skill exactly.

## Verified here (`gradle test`, 9/9; live test skipped)

| Proof | Confirms |
|---|---|
| `analyzePrompt_marksSenderDirection_andTruncatesBody` | Sender-direction (TO you = action, BY you = not) + body truncation |
| `stripHtml_removesTagsAndScripts` | HTML→text for body extraction |
| `schemas_areStructuredOutputCompliant` | All schemas `additionalProperties:false` + `required`; priority enum |
| `requestBody_hasModelEffortAndStructuredFormat` | `claude-opus-4-8`, `effort:"low"`, `output_config.format=json_schema` |
| `parseResponse_extractsStructuredJson` | Structured JSON pulled from the text content block |
| `parseResponse_handlesRefusal_andHttpErrors` | `stop_reason:"refusal"` + HTTP 401/429 → user-facing errors |
| `sweep_reSweepUnchangedInbox_spendsNoTokens` | **Re-sweep of a fully-cached inbox makes 0 API calls, freshCount=0** |
| `sweep_sendsOnlyUncached_cachesResults_dropsCompleted` | Only uncached messages sent; results cached per-row; completed tasks filtered |
| `dedupeKey_normalizesWhitespaceAndCase` | Stable dedupe key |

The incremental sweep is the subtle one — the whole orchestration runs against a
**fake model** (`AiService`'s `invoke` is injected), so the zero-token property
and the cache/dedupe/completed-filter logic are proven without any network.

## The three features

- **Analyze** (`AiService.analyze`) — schema `{summary, actionItems[], questions[],
  keyContext[]}`, `max_tokens 2048`, body cap 8000. Sender-direction system prompt.
- **Draft reply** (`draftReply`) — schema `{reply}`, tone brief/neutral/detailed,
  grounded in up to 12 thread messages (4000-char cap each), `max_tokens 2048`.
- **Tasks sweep** (`sweep`) — schema `{tasks:[{task, priority, sourceMessageId}]}`,
  up to 40 messages, 1500-char cap, `max_tokens 4096`. **Incremental:** only
  messages with a null cache are sent; each analyzed message's tasks (even empty)
  are returned as `cacheUpdates` for the caller to persist on the Step 2
  `sweep_cache` column; completed tasks are injected into the prompt and filtered
  from results.

## How it wires to the other steps

- **Step 2:** the AI caches map to the `messages.ai_analysis` / `sweep_cache`
  columns and `sweep_tasks` table; `AiMessage.sweepCacheJson` is that column.
- **Step 3/6:** the API key lives in Keystore via `ApiKeyStore` — **not** the DB
  (audit §6/§7), unlike the desktop's `app_preferences.ai_api_key`.
- **Step 5:** `AiService` results feed the reader's Analyze panel, the composer's
  draft, and the Tasks dialog.

## Deferred (needs a key / the app project)

- The **live API call** — gated `LiveSmokeTest` (skipped without
  `ANTHROPIC_API_KEY`). It runs the real request/parse end-to-end when a key is
  present; the request shape and parsing are already verified above.
- Keystore-backed `ApiKeyStore` implementation (Android).
- **Attachment blocks in Analyze** (image/PDF/text, 4 MiB cap) — the desktop's
  opt-in attachment context; the text path is complete, attachment encoding is a
  follow-on using the Step 4 attachment fetch.

## Run

```bash
cd android/ai
gradle test                                              # 9 passed, 1 skipped
ANTHROPIC_API_KEY=sk-ant-... gradle test --tests '*LiveSmokeTest*'   # live
```
