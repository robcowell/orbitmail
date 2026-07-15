# IMAP Library Spike (Plan Step 6.1) — Results

**Question the spike answers:** can a JVM/Kotlin IMAP library reproduce Orbit
Mail's sync engine on Android — specifically **XOAUTH2, IDLE, CONDSTORE, SORT,
and single-part BODYSTRUCTURE fetch** — or does a bad answer force a different
sync architecture (the plan's single highest-risk unknown)?

**Answer: GO. Jakarta Mail supports every required capability.** No architecture
change is needed. One important implementation gotcha was found and resolved
(IDLE vs. socket channels — see Finding 2).

---

## Recommendation

Use **Jakarta Mail**, shipped on Android via the Android-blessed artifact:

```kotlin
// Android app module:
implementation("com.sun.mail:android-mail:1.6.7")
implementation("com.sun.mail:android-activation:1.6.7")
```

The spike compiles and runs against `com.sun.mail:jakarta.mail:1.6.7` (the
JVM-runnable build of the same 1.6.x line, same `javax.mail`/`com.sun.mail.imap`
code). Every API and protocol behaviour proven here is byte-identical in
`android-mail:1.6.7`.

- **v1 choice — `android-mail:1.6.7`:** proven Android-compatible, `javax.mail`
  namespace, used by many shipping Android mail clients. Lowest risk.
- **Forward-looking — Angus Mail 2.x** (`org.eclipse.angus:angus-mail`,
  `jakarta.mail` namespace, actively maintained): the same API surface, but
  needs an on-device check (core-library desugaring on Android; minSdk 26+).
  Validate on a device before adopting; not required for v1.
- **Fallback if Jakarta Mail ever proves limiting:** a K-9-style hand-rolled
  IMAP layer. Not needed — the spike found no blocker.

---

## What was tested, and how (three layers)

The container this ran in has **no raw IMAP egress (port 993 is blocked) and no
Gmail credentials**, so a live Gmail run was not possible here. Verification is
layered and honest about that:

| Layer | Method | What it proves | Runs here? |
|---|---|---|---|
| **1 — Compile** | `CapabilityReference.kt` references every needed API; the type checker resolves it against the artifact | The library *exposes* XOAUTH2, IDLE, CONDSTORE, SORT, partial-fetch, UID APIs | ✅ `gradle compileKotlin` |
| **2 — End-to-end** | `ImapSpikeTest.kt` drives **GreenMail**, a real in-process IMAP/SMTP server (actual protocol over a loopback socket — not mocked) | The client *actually works*: IDLE push, single-part fetch, FETCH/STORE/SEARCH/UID, SORT | ✅ `gradle test` |
| **3 — Real Gmail** | `RealGmailSpike.kt` — a ready-to-run CLI you complete with your own token/app-password | Gmail-specific XOAUTH2 handshake + CONDSTORE/HIGHESTMODSEQ + X-GM-RAW | ⏳ handoff (see below) |

All Layer 1 + Layer 2 results below are reproducible with `gradle test` (8 pass,
1 skipped).

---

## Capability matrix

| # | Capability | Needed for | Verified | Result |
|---|---|---|---|---|
| 1 | **XOAUTH2** (IMAP+SMTP) | Gmail/O365 OAuth login & send | L1 compile + L2 SASL wire-format unit test; GreenMail lacks the mechanism so the live handshake is L3 | ✅ **API + wire format proven**; Gmail handshake → L3 |
| 2 | **IMAP IDLE** | Near-realtime inbox push | L2 — real EXISTS push received from GreenMail over a blocking `idle()` on a dedicated thread | ✅ **Proven end-to-end** |
| 3 | **CONDSTORE / CHANGEDSINCE** | Cheap flag reconciliation | L1 compile (`getMessagesByUIDChangedSince`, `getModSeq`); GreenMail doesn't advertise CONDSTORE → L2 skipped | ✅ **API proven**; live → L3 (engine has a full-scan fallback regardless) |
| 4 | **SORT** (`REVERSE DATE`) | Initial-sync ordering | L2 — `getSortedMessages` returned results from GreenMail | ✅ **Proven end-to-end** |
| 5 | **Partial BODYSTRUCTURE fetch** | Download one attachment part, not the whole message | L2 — protocol trace shows `FETCH (BODYSTRUCTURE)` then `FETCH (BODY.PEEK[2]<0.21>)` | ✅ **Proven end-to-end** |
| — | UID sync primitives (UIDVALIDITY/UIDNEXT/by-UID range) | Incremental delta sync | L2 | ✅ |
| — | STORE flags + SEARCH | read/star/delete + server-search fallback | L2 | ✅ |

### Evidence — partial fetch (captured protocol trace, Layer 2)

```
F4 FETCH 1 (BODYSTRUCTURE)
* 1 FETCH (BODYSTRUCTURE (("TEXT" "PLAIN" (...) "7bit" 33 1 ...)
           ("TEXT" "PLAIN" ("charset" "us-ascii" "name" "payload.txt") ...
            ("attachment" ("filename" "payload.txt")) NIL) "mixed" ...))
F5 FETCH 1 (BODY.PEEK[2]<0.21>)      <-- only part 2, PEEK (no \Seen), 21 bytes
* 1 FETCH (BODY[2]<0>{21}
```

This is exactly the `attachment-fetch.ts` design from the audit: fetch structure
first, then stream a single MIME part. `PEEK` means inspecting an attachment
does not mark the message read.

---

## Key findings

### Finding 1 — XOAUTH2 is config-driven; no manual SASL assembly
The audit worried the port might need to hand-assemble
`AUTH XOAUTH2 base64(user=…^Aauth=Bearer …^A^A)`. **It doesn't.** Jakarta Mail
builds the SASL string internally when you set the mechanism and pass the OAuth
**access token where the password goes**:

```kotlin
props["mail.imaps.auth.mechanisms"] = "XOAUTH2"   // (or mail.smtp.auth.mechanisms)
store.connect(host, userEmail, accessToken)        // token as "password"
```

Same shape as the Electron app's imapflow/nodemailer today. The exact wire
format is still unit-asserted in `Xoauth2.kt` / `xoauth2SaslFormat()` as a
reference and fallback.

### Finding 2 — IDLE requires the blocking model (`usesocketchannels=false`)  ⚠️ the one real gotcha
`folder.idle()` (blocking) and `mail.imap.usesocketchannels=true` are mutually
exclusive — with socket channels, `idle()` throws
`"idle method not supported with SocketChannels"`. There are two IDLE styles:

- **Blocking `folder.idle()` on a dedicated thread** — needs
  `usesocketchannels=false`. **This is the model to use** (it maps directly to a
  dedicated IDLE thread inside the Android foreground service from plan Step 2).
- Async `IdleManager` — needs `usesocketchannels=true`; more moving parts, no
  benefit for our one-thread-per-account design.

Decision: **blocking `idle()` on a per-account thread, `usesocketchannels=false`.**
Verified: a real EXISTS push was delivered and the `MessageCountListener` fired.

### Finding 3 — SORT confirmed, CONDSTORE deferred but safe
GreenMail advertises `IMAP4rev1 LITERAL+ UIDPLUS SORT IDLE MOVE QUOTA` — so SORT
is proven end-to-end. It does **not** implement CONDSTORE, so `CHANGEDSINCE`
can't be exercised against it; the API compiles (Layer 1) and Gmail supports
CONDSTORE. Even if a given server lacks it, the audited sync engine already
falls back to a full flags-only scan — so CONDSTORE is an optimization, not a
hard dependency.

---

## Android-specific notes (carry into the app module)

- **Artifact swap only:** `com.sun.mail:jakarta.mail:1.6.7` → `android-mail` +
  `android-activation` at the same 1.6.7 version. No code change — same package.
- **Threading:** one blocking-`idle()` thread per account, owned by the
  foreground service (plan Step 2). Stop it by calling `folder.close()` /
  `store.close()` from another thread (sends `DONE`).
- **Namespace:** the 1.6.x line is `javax.mail`. If you later move to Angus 2.x
  it becomes `jakarta.mail` — mechanical rename, same API.
- **XOAUTH2 token lifecycle:** pass a *fresh* access token to `connect()`;
  refresh via AppAuth/MSAL before connecting (mirrors `ensureFreshToken` in the
  Electron app). Jakarta Mail does not refresh tokens.
- **Desugaring:** `android-mail:1.6.7` runs on Android without desugaring;
  re-check if adopting Angus 2.x.

---

## Residual risk & how to close it (Layer 3)

Two things GreenMail cannot confirm, both low-risk and well-documented for
Gmail, closed by one live run:

1. Gmail's **XOAUTH2** handshake with a real `https://mail.google.com/` token.
2. **CONDSTORE / HIGHESTMODSEQ** semantics on Gmail.

Run against a real account (reads only; never sends/deletes/flags):

```bash
# From android/imap-spike/ — needs Gradle 8.x and JDK 17+.

# Option A — OAuth access token (the real target; scope https://mail.google.com/):
IMAP_USER=you@gmail.com IMAP_ACCESS_TOKEN=ya29.... \
  gradle run --args="gmail"

# Option B — Gmail app password (quicker first check; enable 2FA, make an app pw):
IMAP_USER=you@gmail.com IMAP_PASSWORD=xxxx IMAP_AUTH=password \
  gradle run --args="gmail"
```

It prints a PASS/SKIP/FAIL line per capability, waits up to 20s for an IDLE push
(send yourself a mail to confirm), and never mutates the mailbox.

---

## How to reproduce the automated proof

```bash
cd android/imap-spike
gradle test        # Layer 2 (+ Layer 1 via compile). 8 pass, 1 skipped (CONDSTORE).
```

Requirements: JDK 17+ (built here on JDK 21) and Gradle 8.x (tested on 8.14.3).
See `README.md` for details. No network beyond Maven Central; no credentials.
