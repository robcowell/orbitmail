# Orbit Mail — IMAP library spike

Standalone Kotlin/Gradle spike for **plan Step 6.1**: prove a JVM/Kotlin IMAP
library can reproduce Orbit Mail's sync engine on Android before any app code is
written. **Results and the go/no-go recommendation are in [`SPIKE.md`](SPIKE.md).**

This is throwaway verification scaffolding, not part of the eventual app — it
lives under `android/` because that's where the Android app module will go.

## Requirements

- JDK 17+ (developed on JDK 21)
- Gradle 8.x (tested on 8.14.3) — a system `gradle` is fine; no wrapper is
  committed because this environment can't validate the wrapper distribution URL.

## Run the automated proof (no credentials needed)

```bash
gradle test
```

Drives **GreenMail** (a real in-process IMAP/SMTP server) to verify IDLE push,
single-part BODYSTRUCTURE fetch, SORT, FETCH/STORE/SEARCH, and the UID
primitives, plus the XOAUTH2 SASL wire format. Expect **8 passed, 1 skipped**
(CONDSTORE — GreenMail doesn't implement it; confirmed on Gmail via the live run).

Each check prints a `PROOF[...]` line; the partial-fetch test prints the actual
`BODYSTRUCTURE` / `BODY.PEEK[2]` protocol trace.

## Run against a real account (Layer 3)

Reads only — never sends, deletes, or sets flags.

```bash
# OAuth access token (scope https://mail.google.com/):
IMAP_USER=you@gmail.com IMAP_ACCESS_TOKEN=ya29... gradle run --args="gmail"

# or a Gmail app password:
IMAP_USER=you@gmail.com IMAP_PASSWORD=xxxx IMAP_AUTH=password gradle run --args="gmail"
```

## Layout

| File | Role |
|---|---|
| `src/main/kotlin/.../Xoauth2.kt` | XOAUTH2 SASL + session-property helpers (Finding 1) |
| `src/main/kotlin/.../CapabilityReference.kt` | Layer 1 — compile-time API-surface proof |
| `src/main/kotlin/.../RealGmailSpike.kt` | Layer 3 — live capability probe against a real account |
| `src/main/kotlin/.../Main.kt` | CLI entry (`gmail` / `sasl`) |
| `src/test/kotlin/.../ImapSpikeTest.kt` | Layer 2 — end-to-end proof against GreenMail |
| `SPIKE.md` | Findings, capability matrix, recommendation |
