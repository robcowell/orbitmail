import { createServer, type Server } from 'http'
import { URL } from 'url'

export interface LoopbackResult {
  code: string
  state?: string
}

export function startLoopbackServer(path = '/callback'): Promise<{
  port: number
  waitForCode: () => Promise<LoopbackResult>
  close: () => void
}> {
  let resolveCode: (result: LoopbackResult) => void
  let rejectCode: (err: Error) => void
  const codePromise = new Promise<LoopbackResult>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  let server: Server

  const waitForCode = () =>
    codePromise.catch((err) => {
      throw err
    })

  server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== path) {
        res.writeHead(404)
        res.end('Not found')
        return
      }

      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      const state = url.searchParams.get('state')

      if (error) {
        res.writeHead(400)
        res.end('Authentication failed. You can close this tab.')
        rejectCode(new Error(error))
        return
      }

      if (!code) {
        res.writeHead(400)
        res.end('Missing code')
        rejectCode(new Error('Missing OAuth code'))
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        '<html><body><h2>Orbit Mail</h2><p>Authentication successful. You can close this tab.</p></body></html>'
      )
      resolveCode({ code, state: state ?? undefined })
    } catch (err) {
      rejectCode(err instanceof Error ? err : new Error(String(err)))
    }
  })

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind loopback server'))
        return
      }
      resolve({
        port: addr.port,
        waitForCode,
        close: () => server.close()
      })
    })
    server.on('error', reject)
  })
}

export async function openExternalAuthUrl(url: string): Promise<void> {
  const { shell } = await import('electron')
  await shell.openExternal(url)
}
