// The shared server (server/server.mjs): one per session, started on the first show and kept up by a
// heartbeat. The child lives as long as the loop reading it, which ends with this module or the server.
const HEARTBEAT_MS = 15_000
const START_TIMEOUT_MS = 6_000

let port: number | undefined
let token = ''
let starting: Promise<string | undefined> | undefined
let hasHeartbeat = false

export const isUp = () => port !== undefined

// POSTs to the server's control API. Resolves the parsed answer, or undefined when it didn't answer.
export async function post($: any, path: string, body: unknown = {}): Promise<any> {
  if (port === undefined) return undefined
  try {
    const res = await $.http.fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'x-browser-pane-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return undefined
    return res.text ? JSON.parse(res.text) : {}
  } catch {
    return undefined
  }
}

// Starts the server unless it is up. Resolves undefined once it answers (after `onUp` has told it the
// tabs), or the reason it can't start. The spawn runs from a timer, so the module owns the child and
// not the dispatch that asked for it.
export function ensure($: any, onUp: () => Promise<void>): Promise<string | undefined> {
  if (port !== undefined) return Promise.resolve(undefined)
  if (starting) return starting
  starting = new Promise(resolve => {
    let settled = false
    const settle = (reason: string | undefined) => {
      if (settled) return
      settled = true
      if (reason !== undefined) starting = undefined
      resolve(reason)
    }
    $.clock.after(START_TIMEOUT_MS, () => settle('the browser-pane server did not start in time'))
    $.clock.after(0, () => {
      void (async () => {
        let buffer = ''
        let failure = 'the browser-pane server stopped'
        try {
          const child = $.process.spawn({ argv: ['node', `${$.plugin.root}/server/server.mjs`] })
          for await (const piece of child) {
            if (!('stream' in piece) || piece.stream !== 'stdout' || port !== undefined) continue
            buffer += piece.text
            const newline = buffer.indexOf('\n')
            if (newline < 0) continue
            const hello = JSON.parse(buffer.slice(0, newline))
            token = hello.token
            port = hello.port
            if (!hasHeartbeat) {
              hasHeartbeat = true
              $.clock.every(HEARTBEAT_MS, () => void post($, '/control/ping'))
            }
            await onUp()
            settle(undefined)
          }
        } catch (error) {
          failure = `the browser-pane server can't run here: ${String(error)}`
          $.ui.log(`browser-pane: ${failure}`, { to: 'debug' })
        } finally {
          port = undefined
          token = ''
          starting = undefined
          settle(failure)
        }
      })()
    })
  })
  return starting
}
