// Host-agnostic relay config (decision 1). Everything host-specific comes from
// the environment; nothing about where the relay runs is hardcoded. Defaults are
// dev-friendly, not production assumptions.

export interface RelayConfig {
  // Address/port the HTTP+WS server binds to.
  host: string
  port: number
  // Public URL the PWA uses to reach this relay (user-entered at pairing) and
  // the base for OAuth redirect URIs. No default in production — must be set.
  externalUrl: string | null
  // Durable state (push subscriptions only). File path is env-configured.
  dataDir: string
  // VAPID keys for Web Push (decision 2). Absent = push disabled until set.
  vapid: { publicKey: string; privateKey: string; subject: string } | null
}

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (v === undefined) throw new Error(`Missing required env: ${name}`)
  return v
}

export function loadConfig(): RelayConfig {
  const vapidPublic = process.env.RELAY_VAPID_PUBLIC_KEY
  const vapidPrivate = process.env.RELAY_VAPID_PRIVATE_KEY

  return {
    host: req('RELAY_HOST', '127.0.0.1'),
    port: Number(req('RELAY_PORT', '8787')),
    externalUrl: process.env.RELAY_EXTERNAL_URL ?? null,
    dataDir: req('RELAY_DATA_DIR', './relay-data'),
    vapid:
      vapidPublic && vapidPrivate
        ? {
            publicKey: vapidPublic,
            privateKey: vapidPrivate,
            subject: process.env.RELAY_VAPID_SUBJECT ?? 'mailto:admin@localhost'
          }
        : null
  }
}
