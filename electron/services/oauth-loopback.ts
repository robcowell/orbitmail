import { createServer, type Server, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { URL } from 'url'

// An abandoned sign-in should not leave an HTTP server listening for the life
// of the app, so the wait is bounded.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export interface LoopbackOptions {
  /** The `state` value sent on the authorization request. Required. */
  expectedState: string
  path?: string
  timeoutMs?: number
}

export interface LoopbackServer {
  port: number
  /** Resolves with the authorization code once a matching callback arrives. */
  waitForCode: () => Promise<string>
  close: () => void
}

/** A high-entropy value for the OAuth `state` parameter. */
export function generateState(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Start a loopback listener for an OAuth redirect (RFC 8252).
 *
 * The listener is reachable by anything that can talk to localhost — including
 * any web page the user has open, since browsers permit navigation to
 * 127.0.0.1. Without a check, such a page could deliver *its own* authorization
 * code here and the app would exchange it, binding the attacker's mailbox to
 * the user's client. So a callback is only accepted when its `state` matches
 * the value we generated for this attempt.
 *
 * A mismatched callback is answered and otherwise ignored rather than treated
 * as an error: rejecting would let a hostile page abort a legitimate sign-in
 * simply by racing it.
 */
export function startLoopbackServer(options: LoopbackOptions): Promise<LoopbackServer> {
  const path = options.path ?? '/callback'
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let settle: { resolve: (code: string) => void; reject: (err: Error) => void } | null = null
  let settled = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const codePromise = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject }
  })
  // Nothing awaits the promise until waitForCode() is called, and a rejection
  // before then would be an unhandled rejection.
  codePromise.catch(() => {})

  const finish = (fn: () => void): void => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    fn()
    close()
  }

  const respond = (res: ServerResponse, code: number, body: string): void => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<html><body><h2>Orbit Mail</h2><p>${body}</p></body></html>`)
  }

  const server: Server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== path) {
        res.writeHead(404)
        res.end('Not found')
        return
      }

      const state = url.searchParams.get('state')
      if (state !== options.expectedState) {
        // Not our callback. Answer it, keep waiting for the real one.
        console.warn('[orbit-mail] Ignored an OAuth callback with an unexpected state value.')
        respond(res, 400, 'This sign-in request was not recognised. You can close this tab.')
        return
      }

      const error = url.searchParams.get('error')
      if (error) {
        respond(res, 400, 'Authentication failed. You can close this tab.')
        finish(() => settle?.reject(new Error(error)))
        return
      }

      const code = url.searchParams.get('code')
      if (!code) {
        respond(res, 400, 'Authentication response was missing its code. You can close this tab.')
        finish(() => settle?.reject(new Error('Missing OAuth code')))
        return
      }

      respond(res, 200, 'Authentication successful. You can close this tab.')
      finish(() => settle?.resolve(code))
    } catch (err) {
      finish(() => settle?.reject(err instanceof Error ? err : new Error(String(err))))
    }
  })

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    server.close()
  }

  return new Promise<LoopbackServer>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        close()
        reject(new Error('Failed to bind loopback server'))
        return
      }

      timer = setTimeout(() => {
        finish(() => settle?.reject(new Error('Timed out waiting for the sign-in to complete.')))
      }, timeoutMs)
      // Don't hold the process open on this timer alone.
      timer.unref?.()

      resolve({ port: addr.port, waitForCode: () => codePromise, close })
    })
    server.on('error', reject)
  })
}

export async function openExternalAuthUrl(url: string): Promise<void> {
  const { shell } = await import('electron')
  await shell.openExternal(url)
}
