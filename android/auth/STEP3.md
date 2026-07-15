# OAuth — Client Registration + AppAuth Integration (Plan Step 3)

Replaces the desktop's OAuth stack (loopback HTTP server + `shell.openExternal`
+ `google-auth-library`/`msal-node` + `safeStorage`), none of which has an
Android equivalent (audit §5, §6), with **AppAuth-Android + Chrome Custom Tabs +
Android Keystore**.

## What's here

| Path | Role | Built here? |
|---|---|---|
| `core/` | **Provider-agnostic OAuth logic** (pure Kotlin): configs, scopes, PKCE, auth-URL, token model + refresh, state, response parsing | ✅ `gradle test` (9/9) |
| `appauth/` | **The Android integration** (AppAuth driver, SecureCredentialStore, manifest) | ❌ (Android SDK + AppAuth AAR from Google Maven — both blocked here) |
| `OAUTH_SETUP.md` | **Android client-registration addendum** (the docs deliverable audit §5 calls for) | docs |

Same split rationale as Steps 1–2: the risk-bearing logic (PKCE correctness,
exact scopes, refresh timing, redirect/URL construction) is platform-agnostic
and verified off-device; the AppAuth/Keystore wiring builds in the app project.

## Verified here (`core`, `gradle test`, 9/9)

| Proof | Confirms |
|---|---|
| `pkce_matchesRfc7636TestVector` | S256 `code_challenge` matches the RFC 7636 Appendix B vector — the flow will interop with Google/Microsoft |
| `pkce_generatedVerifier_isUrlSafe_andCorrectLength` | 43-char URL-safe verifier (RFC 43–128); deterministic challenge |
| `googleScopes_matchAudit` | `https://mail.google.com/ openid email profile` (the restricted IMAP/SMTP scope) |
| `microsoftScopes_matchAudit` | `openid profile email offline_access …/IMAP.AccessAsUser.All …/SMTP.Send` |
| `microsoft_endpoints_useConfiguredTenant` | tenant substituted into authorize/token endpoints (`common` default) |
| `authorizationUrl_hasCodeFlowPkceAndProviderParams` | code flow + PKCE(S256) + `access_type=offline` + state + scope + custom-scheme redirect |
| `tokenRefresh_skewLogic` | refresh iff no expiry or within the 120s skew (mirrors desktop `ensureFreshToken`) |
| `state_generatesUrlSafe_andValidatesConstantTime` | CSRF `state` generated + validated (closes the gap where the desktop parsed but never checked it) |
| `tokenResponse_parses_expiryAndRefresh` | `expires_in`→`expiryDate`; missing `refresh_token` falls back to the previous (MS rotates, Google usually doesn't) |

## Android integration (deferred build — `appauth/`)

- `AppAuthAuthenticator` — builds the authorization intent (Custom Tab), handles
  the redirect, exchanges the code, persists `AuthState`, and exposes
  `freshAccessToken(accountId)`. AppAuth performs PKCE + state internally; our
  `OAuthProviderConfig` supplies the exact scopes/endpoints/extra params.
- `SecureCredentialStore` — Keystore + `EncryptedSharedPreferences`; the reason
  `accounts` has no `token_blob` (Step 2). **No plaintext fallback** (audit §6).
- `AndroidManifest.xml` — documents the `appAuthRedirectScheme` placeholder that
  wires the redirect to AppAuth's receiver activity.

## How this connects to the other steps

- **Step 1 (spike):** `freshAccessToken()` returns the token that
  `Xoauth2.imapXoauth2Props` + `store.connect(host, email, token)` consume — the
  XOAUTH2 path already proven end-to-end against GreenMail. OAuth → token →
  IMAP/SMTP is now closed on the config side.
- **Step 2 (data):** tokens go to `SecureCredentialStore` (Keystore), not Room.
- **Step 4 (sync):** the sync engine calls `freshAccessToken()` before each
  connect, replacing the desktop `ensureFreshToken`/`resolveGoogleAccessToken`.

## Deferred (needs the Android app project)

- Compile of `appauth/` (AppAuth AAR + Android SDK) and an instrumented
  round-trip against a real account — inherently interactive (browser consent,
  console-registered client ids). The logic feeding it is verified above; the
  live sign-in is a manual/device step, like the spike's Layer 3.
- Registering the actual client ids (manual console task — see `OAUTH_SETUP.md`).
- `email`/`displayName` resolution from the id_token/userinfo (optional; not
  required for IMAP/SMTP auth).

## Run the verification

```bash
cd android/auth/core
gradle test      # 9 passed
```
