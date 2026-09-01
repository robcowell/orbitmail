/**
 * The message a failed IPC call should actually show the user.
 *
 * Electron wraps every rejection crossing the boundary, so a carefully written
 * main-process error arrives at the renderer as:
 *
 *   Error invoking remote method 'accounts:addManual': Error: Incoming server …
 *
 * Toasts are one line at a bounded width, so that prefix pushes the part the
 * user needs out of view — and names an IPC channel, which means nothing to
 * them. Both layers of noise are stripped: the wrapper, then the `Error:` class
 * tag that the wrapper leaves behind.
 *
 * Only a *leading* wrapper is removed, and the class tag only once, so an error
 * whose own text contains a colon (a server response, a hostname and port)
 * survives intact.
 */
export function ipcErrorMessage(err: unknown, fallback: string): string {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : ''

  const stripped = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(?:[A-Za-z]*Error):\s*/, '')
    .trim()

  return stripped || fallback
}
