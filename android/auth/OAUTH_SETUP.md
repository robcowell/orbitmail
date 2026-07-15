# Android OAuth Setup — Gmail & Microsoft

The Android counterpart to the Electron `DEVELOPERS.md` "OAuth setup" section.
Android needs **separate, different-typed** OAuth clients from the desktop
(audit §5) — this is an addendum, not a config-value swap. Bring-your-own
credentials still applies (no shared client is bundled).

Both providers are **public clients** on Android: **PKCE, no client secret** —
never ship `GOOGLE_CLIENT_SECRET` in an APK.

---

## Google (Gmail)

1. [Google Cloud Console](https://console.cloud.google.com/) → your project →
   **APIs & Services**. Enable the **Gmail API** (same as desktop).
2. **OAuth consent screen** → keep the **restricted** scope
   `https://mail.google.com/` (the only scope granting IMAP/SMTP). Publishing
   status / test-users / CASA rules are identical to desktop — see the Electron
   `DEVELOPERS.md` "Who can sign in" + "Full verification & CASA".
3. **Credentials → Create credentials → OAuth client ID → Android.**
   - **Package name:** the app's applicationId (e.g. `com.orbitmail.app`).
   - **SHA-1 signing-certificate fingerprint:** from your debug/release keystore
     (`keytool -list -v -keystore <ks> -alias <alias>` → SHA1). Add debug AND
     release fingerprints (Play App Signing adds another).
   - No client secret is issued for Android clients.
4. **Redirect scheme:** the **reversed client id**,
   `com.googleusercontent.apps.<CLIENT_ID_PREFIX>`, with path `/oauth2redirect`.
   Put it in the app's build config:
   ```kotlin
   // app build.gradle.kts
   manifestPlaceholders["appAuthRedirectScheme"] = "com.googleusercontent.apps.<CLIENT_ID_PREFIX>"
   buildConfigField("String", "GOOGLE_CLIENT_ID", "\"<full-android-client-id>\"")
   ```
5. IMAP must be enabled in each Gmail account (unchanged from desktop).

`OAuthConfigs.google(clientId = BuildConfig.GOOGLE_CLIENT_ID, redirectScheme = "com.googleusercontent.apps.<prefix>")`
already encodes the endpoints, the four scopes, and `access_type=offline` /
`prompt=consent` (verified in `core`).

---

## Microsoft (Office 365 / Outlook)

1. [Entra admin center](https://portal.azure.com/) → **App registrations → New
   registration**. **Supported account types:** match desktop (e.g. any org
   directory + personal Microsoft accounts).
2. **Authentication → Add a platform → Mobile and desktop applications.** Add a
   **custom redirect URI** matching the app's scheme, e.g.
   `com.orbitmail.app://oauth2redirect` (host optional; scheme must match the
   manifest placeholder). *(This is the Android difference: the desktop used the
   `http://127.0.0.1/callback` loopback, which does not exist on Android.)*
3. **Authentication → Advanced settings → Allow public client flows → Yes**
   (required for the PKCE public-client refresh flow).
4. Copy the **Application (client) ID**:
   ```kotlin
   buildConfigField("String", "MICROSOFT_CLIENT_ID", "\"<application-client-id>\"")
   buildConfigField("String", "MICROSOFT_TENANT_ID", "\"common\"")
   manifestPlaceholders["appAuthRedirectScheme"] = "com.orbitmail.app"
   ```
5. No API permissions needed in the portal — the IMAP/SMTP scopes
   (`IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`) are consented in the
   browser at sign-in (unchanged from desktop). Your tenant must allow OAuth
   IMAP/SMTP.

`OAuthConfigs.microsoft(clientId = BuildConfig.MICROSOFT_CLIENT_ID, redirectScheme = "com.orbitmail.app", tenant = BuildConfig.MICROSOFT_TENANT_ID)`
encodes the endpoints and the six scopes (verified in `core`).

---

## If Google and Microsoft need different redirect schemes

`manifestPlaceholders` holds one `appAuthRedirectScheme`. When the schemes
differ (Google's reversed-client-id vs. Microsoft's app scheme), declare a
provider-specific `<activity-alias>` for
`net.openid.appauth.RedirectUriReceiverActivity` per scheme in the **app**
module's manifest, instead of relying on the single placeholder.
