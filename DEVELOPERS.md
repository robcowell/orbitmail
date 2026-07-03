# Orbit Mail — Developer Guide

Technical documentation for building, configuring, and contributing to Orbit Mail. For end-user installation and usage, see [README.md](README.md).

## Requirements

- **Node.js** 20 or later
- **Linux** desktop (developed on Linux Mint Cinnamon; other desktops supported)
- **Build tools** — needed for the `better-sqlite3` native module (`build-essential`, Python 3, etc.)
- **OAuth credentials** — required for Gmail and Microsoft 365 during development (see [OAuth setup](#oauth-setup))

## Quick start

```bash
git clone <your-repo-url> orbit-mail
cd orbit-mail
npm install
cp .env.example .env
# Edit .env with your OAuth client IDs (for Gmail/O365)
npm run dev
```

If Electron fails to start because `ELECTRON_RUN_AS_NODE` is set in your shell:

```bash
unset ELECTRON_RUN_AS_NODE
npm run dev
```

### Dev app menu launcher

Generates a `.desktop` file that runs `npm run dev` from the project directory:

```bash
npm run icons
npm run install:desktop
```

If the launcher icon is missing, run `npm run icons` before `npm run install:desktop`.

## OAuth setup

OAuth client IDs are loaded from a `.env` file at dev/build time. End users of packaged builds need registered app credentials until in-app OAuth configuration is added (see [Known limitations](#known-limitations)).

**Bring-your-own-credentials.** Orbit Mail does **not** ship with bundled Google/Microsoft credentials. Established open-source clients — Thunderbird (Mozilla), and Evolution/Geary via GNOME Online Accounts — each register one OAuth client, take it through full verification, and embed it so sign-in "just works" for every user. That approach carries a recurring verification and security-assessment burden (see [Full verification & CASA](#full-verification--casa-public-distribution-only)) that only an org can realistically sustain. Instead, each person running Orbit Mail (or building their own copy) registers their **own** OAuth app and drops the client ID into `.env`. The cost of that model is the one-time setup below, plus an "unverified app" click-through per account — in exchange for zero verification cost and no user cap beyond Google's unverified 100.

```bash
cp .env.example .env
```

### Google (Gmail)

1. Open [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project and enable the **Gmail API**
3. Configure the OAuth consent screen (**External**)
4. Create credentials → **Desktop app**
5. Add the `https://mail.google.com/` scope to the consent screen (this is the only scope that grants IMAP/SMTP access, and Google classes it as **restricted**)
6. Copy the Client ID and Client Secret into `.env`:

```env
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
```

**Gmail notes**

- IMAP must be enabled in each Gmail account's settings.

**Who can sign in (publishing status)**

The code accepts any Gmail account; what limits sign-in is your OAuth app's publishing status:

| Status | Who can sign in | Caveats |
| --- | --- | --- |
| **Testing** | Only Google accounts on the **test users** allowlist (max 100) | Refresh tokens **expire after 7 days**, so accounts must re-auth weekly |
| **In production**, unverified | **Any** Gmail account | Users see an "unverified app" warning to click through; hard cap of **100 total users**; refresh tokens no longer expire at 7 days |
| **In production**, verified | **Any** Gmail account | No warnings, no user cap; requires brand verification + an annual **CASA security assessment** for the restricted scope (weeks to complete) |

To let **any** Gmail account sign in: OAuth consent screen → **Audience** → **Publish app**. Each new user clicks **Advanced → Go to Orbit Mail (unsafe)** past the unverified-app screen until you complete full restricted-scope verification (only needed for wide public distribution).

#### Full verification & CASA (public distribution only)

You only need this to **remove the unverified-app warning and exceed 100 users** — i.e. to distribute Orbit Mail so anyone can install it and sign in without registering their own credentials. For personal use or a small group, the unverified-production path above costs nothing; skip this section.

Because `https://mail.google.com/` is a **restricted** scope (the strictest tier), full verification is two layers:

1. **OAuth app verification** (brand + app review) — *free*, but requires a domain you own and have verified, a public homepage and **privacy policy** hosted on it, per-scope justifications, and a YouTube demo of the consent flow. Google reviews manually; expect days to weeks.
2. **CASA** (Cloud Application Security Assessment) — an **annual, paid** security assessment by a Google-authorized third-party assessor (via the App Defense Alliance), plus ongoing compliance with Google's **Limited Use** policy (no ads, restricted human review, no data resale). Cost is assessor- and complexity-dependent — roughly **low single-thousands up to ~$15k USD per year** — and it **recurs every year**. A remediation round adds cost if the assessment finds gaps.

There is no lighter Gmail scope that avoids this — the narrower Gmail API scopes (`gmail.modify`, `gmail.readonly`, …) are *also* restricted, so a full mail client can't design its way around CASA.

**How the big OSS clients absorb it:** Thunderbird (Mozilla/MZLA) and Evolution/Geary (GNOME) each maintain one verified client and complete the assessment at the org level, so individual users never see a warning. A solo/indie project can't realistically sustain a recurring four-to-five-figure annual assessment for a free app — which is exactly why Orbit Mail uses bring-your-own-credentials instead.

Figures are ballpark and the program changes over time; get current quotes from ADA-authorized assessors before budgeting. Microsoft's platform has **no equivalent** restricted-scope assessment for the IMAP/SMTP flow used here.

### Microsoft (Office 365 / Outlook)

1. Open [Microsoft Entra admin center](https://portal.azure.com/) → **App registrations** → **New registration**
2. Set **Supported account types** to match the accounts you'll sign in with (e.g. _Accounts in any organizational directory and personal Microsoft accounts_ for both work and outlook.com)
3. Under **Authentication** → **Add a platform** → **Mobile and desktop applications**
4. Add the loopback redirect URI **exactly**: `http://127.0.0.1/callback`
   - Entra ignores the port for loopback URIs, so this single entry covers the random port Orbit Mail listens on. The host (`127.0.0.1`) and path (`/callback`) must match.
5. Under **Authentication** → **Advanced settings**, set **Allow public client flows** to **Yes** (required for the desktop sign-in + refresh-token flow)
6. Copy the **Application (client) ID** into `.env`:

```env
MICROSOFT_CLIENT_ID=your-microsoft-client-id
MICROSOFT_TENANT_ID=common
```

**Microsoft notes**

- **You do not need to add API permissions in the portal.** Orbit Mail requests the IMAP/SMTP scopes (`IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`) dynamically at sign-in, and you consent in the browser. This is why "Office 365 Exchange Online" not appearing under **API permissions → APIs my organization uses** does not matter for this flow.
- That API only appears for tenants with an active Exchange Online license; for personal Microsoft accounts it is absent by design. If your tenant admin requires _pre-consent_, you can add it by searching the GUID `00000002-0000-0ff1-ce00-000000000000`, but it is optional here.
- Your tenant administrator must allow OAuth-based IMAP/SMTP (some tenants disable IMAP/SMTP entirely).
- `MICROSOFT_TENANT_ID=common` works for most cases; use your specific tenant GUID to restrict sign-in to one organization.

## AI (optional)

The AI features — per-message **Analyze** and the unread-folder **Tasks** sweep — are off unless the user supplies an Anthropic API key. Unlike the OAuth credentials above, this key is **not** read from `.env`: it's entered in-app (✦ toolbar button → AI settings), encrypted with Electron `safeStorage`, and stored in the `app_preferences` table under `ai_api_key`. So there is nothing to configure at build time for AI.

`electron/services/ai-service.ts` uses `@anthropic-ai/sdk` with model `claude-opus-4-8` and structured output. Per-message analysis is cached on the `messages` row (`ai_analysis` / `ai_analysis_at`); the inbox sweep is a single batched call and is not cached. Message content is sent to Anthropic only when the user triggers a feature.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Renderer (React + Zustand)                             │
│  Three-pane UI · Compose · Search · Preferences         │
└───────────────────────────┬─────────────────────────────┘
                            │ typed IPC (contextBridge)
┌───────────────────────────▼─────────────────────────────┐
│  Main process (Electron)                                │
│  IMAP sync · SMTP send · OAuth · IDLE · Notifications   │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│  SQLite (better-sqlite3 + Drizzle) + FTS5               │
└─────────────────────────────────────────────────────────┘
```

| Layer | Technology |
|-------|------------|
| Shell | Electron 34, electron-vite |
| UI | React 18, TypeScript, Zustand, Phosphor Icons |
| IMAP | imapflow (sync, IDLE, move, flags) |
| POP3 | node-pop3 (inbox-only sync) |
| SMTP | nodemailer |
| Parsing | mailparser |
| OAuth | google-auth-library, @azure/msal-node |
| AI (optional) | @anthropic-ai/sdk (Claude Opus 4.8) |
| Storage | better-sqlite3, Drizzle ORM, FTS5 |
| HTML sanitization | DOMPurify |

### Sync model

- **Initial sync** — up to 200 messages per folder (UID-sorted batch)
- **Incremental sync** — UID-based delta fetch; only new UIDs since `highestSyncedUid`
- **Background poll** — every 20 seconds when IDLE is unavailable
- **IMAP IDLE** — inbox folders on supported accounts for near-realtime delivery
- **Unread counts** — recalculated from local message read state after fetch (kept in sync with the message list)

### Project layout

```
orbit-mail/
├── electron/           # Main process: sync, OAuth, DB, IPC
│   ├── main.ts
│   ├── preload.ts
│   ├── db/             # Schema, migrations, FTS
│   └── services/       # imap-sync, smtp-send, oauth-*, etc.
├── src/                # Renderer: React UI
├── shared/             # Types shared between main and renderer
├── build/              # Icons and .desktop template
├── scripts/            # Icon generation, dev launcher install
└── release/            # electron-builder output (after dist)
```

### Key modules

| Path | Role |
|------|------|
| `electron/services/imap-sync.ts` | IMAP sync, UID tracking, background poll |
| `electron/services/imap-idle.ts` | IMAP IDLE connections per account |
| `electron/services/db-service.ts` | SQLite CRUD, unread recalculation |
| `electron/services/ai-service.ts` | Optional AI: message analysis, inbox task sweep, encrypted Anthropic key storage |
| `electron/preload.ts` | Typed `window.orbitMail` IPC bridge |
| `shared/types.ts` | Shared types and `OrbitMailAPI` contract |
| `src/stores/mailStore.ts` | Renderer state, message list refresh |
| `src/stores/persistence.ts` | UI preference persistence |

Local database path: `~/.config/orbit-mail/data/orbit-mail.db`

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Build main, preload, and renderer for production |
| `npm run preview` | Preview production build |
| `npm run icons` | Regenerate PNG icons from `build/icon.svg` |
| `npm run install:desktop` | Install a dev `.desktop` launcher |
| `npm run dist` | Build icons, compile, and package (.deb + AppImage) |
| `npm run dist:deb` | Debian package only |
| `npm run dist:appimage` | AppImage only |

## Building & packaging

Regenerate icons before building distributables:

```bash
npm run icons
```

### Build from source

```bash
npm run build
```

Output goes to `out/` (main, preload, and renderer bundles).

### Linux packages

```bash
npm run dist          # .deb + AppImage
npm run dist:deb      # .deb only
npm run dist:appimage # AppImage only
```

Install the Debian package:

```bash
sudo dpkg -i release/Orbit\ Mail-*.deb
```

Packaged builds install a `.desktop` launcher with `StartupWMClass=orbit-mail` for correct taskbar/window grouping on Cinnamon and other desktops. `mailto:` handling is opt-in so the app does not hijack links from browsers or admin consoles.

OAuth credentials from `.env` are embedded at build time via electron-vite environment loading — rebuild after changing `.env`.

## Troubleshooting (development)

**Account add fails (Google)**  
Confirm IMAP is enabled, the consent screen includes `https://mail.google.com/`, and your account is a test user if the app is in Testing mode.

**Account add fails (Microsoft)**  
Register the redirect URI exactly as `http://127.0.0.1/callback`, set **Allow public client flows** to **Yes**, and confirm your tenant allows OAuth IMAP/SMTP. You do **not** need to add "Office 365 Exchange Online" API permissions — scopes are consented in the browser at sign-in. If you see "no refresh token", re-check that public client flows are enabled and try again.

**`better-sqlite3` compile errors on install**  
Install build essentials: `sudo apt install build-essential python3`.

**Electron won't start (`ELECTRON_RUN_AS_NODE`)**  
Run `unset ELECTRON_RUN_AS_NODE` before `npm run dev`.

**Unread badge ahead of message list**  
Folder unread counts are updated after messages are persisted during sync. If you see a mismatch, check for stale renderer refresh timing in `src/stores/mailStore.ts` and `syncFolder` in `electron/services/imap-sync.ts`.

## Known limitations

See [`TODO.md`](TODO.md) for the full backlog. Critical item for distribution:

- **End-user OAuth** — packaged users cannot sign in without developer-supplied client IDs in `.env` at build time; no in-app OAuth settings yet

## License

MIT
