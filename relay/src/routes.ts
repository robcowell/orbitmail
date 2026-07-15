// The relay's HTTP contract — the relay subset of OrbitMailAPI (see DESIGN.md).
// Each route is declared here with its method/path so the server and the harness
// share one source of truth. Handlers are wired incrementally; until then a route
// resolves to `notImplemented`, which the server renders as 501 with the route's
// name so the contract is inspectable end-to-end before the protocol code lands.

export interface RouteResult {
  status: number
  body: unknown
}

export type RouteHandler = (payload: unknown) => Promise<RouteResult> | RouteResult

export interface Route {
  method: 'GET' | 'POST'
  path: string
  // Human name used in 501 responses and logs.
  name: string
  handler: RouteHandler
}

function notImplemented(name: string): RouteHandler {
  return () => ({
    status: 501,
    body: { error: 'not_implemented', route: name }
  })
}

// Relay-side operations only — the local-only cache reads (list/count/get/prefs)
// live in the PWA against OPFS, not here (DESIGN.md "API surface").
export const routes: Route[] = [
  { method: 'GET', path: '/health', name: 'health', handler: () => ({ status: 200, body: { ok: true } }) },

  { method: 'POST', path: '/accounts/oauth/exchange', name: 'accounts.oauth.exchange', handler: notImplemented('accounts.oauth.exchange') },
  { method: 'POST', path: '/accounts/manual/validate', name: 'accounts.manual.validate', handler: notImplemented('accounts.manual.validate') },
  { method: 'POST', path: '/accounts/autodetect', name: 'accounts.autodetect', handler: notImplemented('accounts.autodetect') },

  { method: 'POST', path: '/sync/refresh', name: 'sync.refresh', handler: notImplemented('sync.refresh') },
  { method: 'GET', path: '/sync/status', name: 'sync.status', handler: notImplemented('sync.status') },

  { method: 'POST', path: '/messages/mutate', name: 'messages.mutate', handler: notImplemented('messages.mutate') },
  { method: 'POST', path: '/messages/fetchBody', name: 'messages.fetchBody', handler: notImplemented('messages.fetchBody') },
  { method: 'POST', path: '/attachments/fetch', name: 'attachments.fetch', handler: notImplemented('attachments.fetch') },

  { method: 'POST', path: '/compose/send', name: 'compose.send', handler: notImplemented('compose.send') },
  { method: 'POST', path: '/search/server', name: 'search.server', handler: notImplemented('search.server') },
  { method: 'POST', path: '/folders/mutate', name: 'folders.mutate', handler: notImplemented('folders.mutate') },

  { method: 'POST', path: '/push/subscribe', name: 'push.subscribe', handler: notImplemented('push.subscribe') },
  { method: 'POST', path: '/push/unsubscribe', name: 'push.unsubscribe', handler: notImplemented('push.unsubscribe') }
]
