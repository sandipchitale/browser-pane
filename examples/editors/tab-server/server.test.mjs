// The editors' server module behind browser-pane's real request handler, with a fake `claude` CLI.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..', '..', '..')
const TOKEN = 't'
const SID = crypto.randomUUID()

// A `claude` that prints its arguments, so a test sees exactly what would have run.
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-editors-'))
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "$@"\n', { mode: 0o755 })
process.env.CLAUDE_BIN = path.join(bin, 'claude')
// A home of its own: no real transcripts or MCP configs are read.
process.env.HOME = bin

const { createApp } = await import(path.join(repo, 'server', 'app.mjs'))
const { actionArgs } = await import('./server.mjs')

async function serve() {
  const app = createApp({ token: TOKEN, shellDir: path.join(repo, 'server', 'shell'), openWindow: async () => true })
  const server = http.createServer((req, res) => app.handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  app.setPort(port)
  const base = `http://127.0.0.1:${port}`
  const control = (name, body) => fetch(`${base}/control/${name}`, { method: 'POST', headers: { 'x-browser-pane-token': TOKEN }, body: JSON.stringify(body) })
  const page = (p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { cookie: `bp_${port}=${TOKEN}` } })
  for (const id of ['plugins', 'mcp', 'cockpit'])
    await control('register', { id, title: id, root: path.join(here, '..', 'tabs', id), server: path.join(here, 'server.mjs') })
  return { control, page, close: () => server.close() }
}

test('each tab serves its page and the shared stylesheet', async t => {
  const s = await serve()
  t.after(s.close)
  for (const id of ['plugins', 'mcp', 'cockpit']) {
    assert.equal((await s.page(`/tab/${id}/`)).status, 200, id)
    const css = await s.page(`/tab/${id}/api/tailwind.css`)
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8')
  }
})

test('a tab answers only its own routes', async t => {
  const s = await serve()
  t.after(s.close)
  assert.equal((await s.page('/tab/plugins/api/mcp/config')).status, 404)
  assert.equal((await s.page('/tab/mcp/api/cockpit/state')).status, 404)
  assert.equal((await s.page('/tab/cockpit/api/state')).status, 404)
  assert.equal((await s.page('/tab/mcp/api/mcp/config')).status, 200)
})

test('details reads its name from the query, and refuses a bad one', async t => {
  const s = await serve()
  t.after(s.close)
  assert.deepEqual(await (await s.page('/tab/plugins/api/details?name=alpha%40demo')).json(), { ok: true, text: 'plugin details alpha@demo' })
  assert.equal((await s.page('/tab/plugins/api/details?name=--help')).status, 400)
})

test('actions run only from the allow-list, with validated arguments', async t => {
  const s = await serve()
  t.after(s.close)
  const act = body => s.page('/tab/plugins/api/action', { method: 'POST', body: JSON.stringify(body) })
  assert.deepEqual((await (await act({ action: 'install', plugin: 'alpha@demo', scope: 'user' })).json()).args, ['install', 'alpha@demo', '--scope', 'user'])
  assert.equal((await act({ action: 'install', plugin: 'a b' })).status, 400)
  assert.equal((await act({ action: 'install', plugin: 'alpha', scope: 'global' })).status, 400)
  assert.equal((await act({ action: 'rm -rf' })).status, 400)
  assert.equal(actionArgs({ action: 'marketplace-add', source: '--evil' }), null)
})

test('the cockpit follows the session it is told, and skips an event it has seen', async t => {
  const s = await serve()
  t.after(s.close)
  assert.deepEqual(await (await s.page('/tab/cockpit/api/cockpit/state')).json(), { empty: true, current: '' })
  const event = { at: Date.now(), kind: 'prompt', text: 'hello cockpit' }
  await s.control('data', { tab: 'cockpit', data: { session: SID, cwd: bin, key: 'k1', event } })
  await s.control('data', { tab: 'cockpit', data: { session: SID, cwd: bin, key: 'k1', event } })
  const state = await (await s.page('/tab/cockpit/api/cockpit/state')).json()
  assert.equal(state.current, SID)
  assert.equal(state.liveEvents, 1)
  const hits = (await (await s.page('/tab/cockpit/api/cockpit/search?q=hello')).json()).hits
  assert.equal(hits.length, 1)
})

test('the cockpit shows what the session last measured, kept across events that carry none', async t => {
  const s = await serve()
  t.after(s.close)
  // The module is shared by every test here: a session of its own keeps its events out of the others'.
  const sid = crypto.randomUUID()
  const usage = { context: { tokens: 84_100, window: 200_000, percent: 42 }, rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-18T14:15:00Z' }], cost: { usd: 1.234 } }
  await s.control('data', { tab: 'cockpit', data: { session: sid, cwd: bin, usage } })
  await s.control('data', { tab: 'cockpit', data: { session: sid, cwd: bin, key: 'k9', event: { at: Date.now(), kind: 'prompt', text: 'x' } } })
  assert.deepEqual((await (await s.page('/tab/cockpit/api/cockpit/state')).json()).usage, usage)
})
