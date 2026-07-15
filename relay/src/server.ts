// Minimal HTTP server that boots on Node built-ins alone (no npm install needed),
// so the route contract in routes.ts is inspectable before any protocol deps are
// installed. The WebSocket push channel (sync:status / mail:new) is declared in
// DESIGN.md and wired once the `ws` dependency is added; this skeleton exposes the
// request/response surface and health check.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { loadConfig } from './config.ts'
import { routes } from './routes.ts'

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(json)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve(undefined)
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid_json'))
      }
    })
    req.on('error', reject)
  })
}

export function createRelayServer() {
  const config = loadConfig()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://relay.local')
    const route = routes.find((r) => r.method === req.method && r.path === url.pathname)

    if (!route) {
      send(res, 404, { error: 'not_found', path: url.pathname })
      return
    }

    try {
      const payload = req.method === 'POST' ? await readBody(req) : undefined
      const result = await route.handler(payload)
      send(res, result.status, result.body)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      send(res, message === 'invalid_json' ? 400 : 500, { error: message })
    }
  })

  return { server, config }
}

// Entry point: `node --experimental-strip-types src/server.ts`
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const { server, config } = createRelayServer()
  server.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(`orbit-mail relay listening on http://${config.host}:${config.port}`)
    // eslint-disable-next-line no-console
    console.log(`  push: ${config.vapid ? 'configured' : 'disabled (set RELAY_VAPID_* to enable)'}`)
  })
}
