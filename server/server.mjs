// The browser-pane server: one per Claude Code session. Prints {"port":N,"token":"…"} on stdout once
// listening, and exits when the mod's heartbeat (POST /control/ping) stops for IDLE_MS.
//
// It leaves the window alone when it exits: Chrome may be shared with another session's window (one
// profile, one process), and the page itself says the session ended once its polls fail.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const CHROME = process.env.BROWSER_PANE_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PROFILE = process.env.BROWSER_PANE_PROFILE ?? path.join(os.tmpdir(), 'claude-browser-pane-profile')
const IDLE_MS = Number(process.env.BROWSER_PANE_IDLE_MS ?? 60_000)
const TOKEN = crypto.randomUUID()

const log = line => process.stderr.write(`browser-pane: ${line}\n`)

// argv only, never a shell. Resolves true when the command worked.
function attempt(argv, trustExit = false) {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0 || trustExit))
  })
}

async function openWindow(url) {
  // For tests and smoke runs: say where the window would open, and open nothing.
  if (process.env.BROWSER_PANE_NO_WINDOW) {
    log(`window: ${url}`)
    return true
  }
  // Chrome in a profile of its own, as an app window (no tabs or address bar).
  if (fs.existsSync(CHROME)) {
    const child = spawn(CHROME, [`--app=${url}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,860'], {
      stdio: 'ignore',
      detached: true,
    })
    child.on('error', error => log(`chrome: ${error.message}`))
    child.unref()
    return true
  }
  for (const argv of [['open', url], ['xdg-open', url]]) if (await attempt(argv)) return true
  return attempt(['cmd', '/c', 'start', '', url], true)
}

const app = createApp({ token: TOKEN, shellDir: path.join(here, 'shell'), openWindow, log })
const server = http.createServer((req, res) => {
  app.handler(req, res).catch(error => {
    log(`${req.method} ${req.url}: ${error?.message ?? error}`)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

// A tab module's stray rejection is its own trouble, not the other tabs'.
process.on('unhandledRejection', error => log(`unhandled: ${error?.message ?? error}`))
process.on('uncaughtException', error => log(`uncaught: ${error?.message ?? error}`))

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  app.setPort(port)
  process.stdout.write(JSON.stringify({ port, token: TOKEN }) + '\n')
})

const shutdown = () => {
  server.close()
  process.exit(0)
}
setInterval(() => {
  if (Date.now() - app.lastControl() > IDLE_MS) shutdown()
}, 5000).unref()
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
