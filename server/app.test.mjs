// node --test server/
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, listFiles, relativeKey } from './app.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const TOKEN = 'test-token'

// A tab folder with a page, a nested file, a dotfile, and a link that leads out of it.
function tabFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-tab-'))
  const root = path.join(dir, 'tab')
  fs.mkdirSync(path.join(root, 'js'), { recursive: true })
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>tab</h1>')
  fs.writeFileSync(path.join(root, 'js', 'app.js'), 'ok()')
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1')
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'private')
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(root, 'link.txt'))
  return { dir, root }
}

// The app on a real port, with a clock the test moves and a window opener that records.
async function serve(options = {}) {
  let time = 1_000_000
  const opened = []
  const app = createApp({
    token: TOKEN,
    shellDir: path.join(here, 'shell'),
    openWindow: async url => (opened.push(url), true),
    now: () => time,
    ...options,
  })
  const server = http.createServer((req, res) => app.handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  app.setPort(port)
  const base = `http://127.0.0.1:${port}`
  const cookie = `bp_${port}=${TOKEN}`
  const control = (name, body) =>
    fetch(`${base}/control/${name}`, { method: 'POST', headers: { 'x-browser-pane-token': TOKEN }, body: JSON.stringify(body ?? {}) })
  const page = (p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { cookie, ...(init.headers ?? {}) }, redirect: 'manual' })
  // fetch can't send a path with `..` or a Host of our choosing; a raw request can.
  const raw = (p, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, headers: { cookie, ...headers } }, res => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
      req.end()
    })
  return { app, server, port, base, control, page, raw, opened, tick: ms => (time += ms), close: () => server.close() }
}

test('relativeKey refuses anything that leaves the tab', () => {
  assert.equal(relativeKey(''), 'index.html')
  assert.equal(relativeKey('js/'), 'js/index.html')
  assert.equal(relativeKey('js/app.js'), 'js/app.js')
  assert.equal(relativeKey('my%20page.html'), 'my page.html')
  for (const bad of ['..', '../x', 'a/../b', '%2e%2e/x', '..%2fx', 'a%2fb', 'a%5cb', '.env', 'x/.git/config', '%00', '%zz', '/etc/passwd'])
    assert.equal(relativeKey(bad), undefined, bad)
})

test('listFiles lists the tab, leaving out dotfiles and links that lead outside', () => {
  const { root } = tabFixture()
  assert.deepEqual([...listFiles(root).keys()].sort(), ['index.html', 'js/app.js'])
})

test('control needs the token, and every request this server\'s own Host', async t => {
  const s = await serve()
  t.after(s.close)
  assert.equal((await fetch(`${s.base}/control/ping`, { method: 'POST' })).status, 403)
  assert.equal((await s.control('ping')).status, 204)
  assert.equal(await s.raw('/api/state', { host: 'evil.example' }), 421)
  assert.equal(await s.raw('/api/state', { host: `localhost:${s.port}` }), 421)
})

test('the window\'s token URL sets this port\'s cookie; pages need it', async t => {
  const s = await serve()
  t.after(s.close)
  assert.equal((await fetch(`${s.base}/`)).status, 403)
  assert.equal((await fetch(`${s.base}/?t=wrong`)).status, 403)
  const res = await fetch(`${s.base}/?t=${TOKEN}&tab=guide`, { redirect: 'manual' })
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), '/?tab=guide')
  assert.match(res.headers.get('set-cookie'), new RegExp(`^bp_${s.port}=${TOKEN}; HttpOnly; SameSite=Strict`))
  assert.equal((await s.page('/')).status, 200)
  assert.equal((await s.page('/bp/client.js')).status, 200)
  // Another port's cookie is not this one's.
  assert.equal((await fetch(`${s.base}/`, { headers: { cookie: `bp_1=${TOKEN}` } })).status, 403)
})

test('a page on another local port can\'t use the cookie it sends along', async t => {
  const s = await serve()
  t.after(s.close)
  const { root } = tabFixture()
  await s.control('register', { id: 'demo', title: 'Demo', root })
  for (const site of ['same-site', 'cross-site']) {
    assert.equal(await s.raw('/tab/demo/', { 'sec-fetch-site': site }), 403, site)
    assert.equal(await s.raw('/api/state', { 'sec-fetch-site': site }), 403, site)
  }
  assert.equal(await s.raw('/tab/demo/', { 'sec-fetch-site': 'same-origin' }), 200)
  assert.equal(await s.raw('/', { 'sec-fetch-site': 'none' }), 200)
})

test('register validates the tab and lists it', async t => {
  const s = await serve()
  t.after(s.close)
  const { root } = tabFixture()
  assert.equal((await s.control('register', { id: 'Bad', title: 'x', root })).status, 400)
  assert.equal((await s.control('register', { id: 'guide', title: 'x', root })).status, 400)
  assert.equal((await s.control('register', { id: 'ok', title: 'x', root: 'relative' })).status, 400)
  assert.equal((await s.control('register', { id: 'demo', title: 'Demo', root, description: 'A demo' })).status, 200)
  const state = await (await s.page('/api/state')).json()
  assert.deepEqual(state.tabs, [{ id: 'demo', title: 'Demo', description: 'A demo' }])
})

test('a pinned tab says so in the list; a tab that is not says nothing', async t => {
  const s = await serve()
  t.after(s.close)
  const { root } = tabFixture()
  await s.control('register', { id: 'plain', title: 'Plain', root })
  await s.control('register', { id: 'pinned', title: 'Pinned', root, pinned: true })
  await s.control('register', { id: 'odd', title: 'Odd', root, pinned: 'yes' })
  assert.deepEqual((await (await s.page('/api/state')).json()).tabs.map(x => [x.id, x.pinned]), [['plain', undefined], ['pinned', true], ['odd', undefined]])
})

test('a tab whose folder is gone is no longer listed', async t => {
  const s = await serve()
  t.after(s.close)
  const kept = tabFixture()
  const gone = tabFixture()
  await s.control('register', { id: 'kept', title: 'Kept', root: kept.root })
  await s.control('register', { id: 'gone', title: 'Gone', root: gone.root })
  fs.rmSync(gone.dir, { recursive: true })
  assert.deepEqual((await (await s.page('/api/state')).json()).tabs.map(x => x.id), ['kept'])
})

test('a tab serves only its own files', async t => {
  const s = await serve()
  t.after(s.close)
  const { root } = tabFixture()
  await s.control('register', { id: 'demo', title: 'Demo', root })
  assert.equal(await (await s.page('/tab/demo/')).text(), '<h1>tab</h1>')
  assert.equal(await (await s.page('/tab/demo/js/app.js')).text(), 'ok()')
  for (const bad of ['/tab/demo/.env', '/tab/demo/link.txt', '/tab/demo/../../etc/passwd', '/tab/demo/%2e%2e/outside.txt', '/tab/demo/..%2foutside.txt', '/tab/demo/js%2f..%2f..%2foutside.txt', '/tab/nope/index.html'])
    assert.equal(await s.raw(bad), 404, bad)
  assert.equal((await fetch(`${s.base}/tab/demo/`)).status, 403)
})

test('a file added to a tab is found again on a miss, a second later', async t => {
  const s = await serve()
  t.after(s.close)
  const { root } = tabFixture()
  await s.control('register', { id: 'demo', title: 'Demo', root })
  fs.writeFileSync(path.join(root, 'new.html'), 'new')
  assert.equal((await s.page('/tab/demo/new.html')).status, 404)
  s.tick(1000)
  assert.equal(await (await s.page('/tab/demo/new.html')).text(), 'new')
})

test('show opens a window once, then switches the one that polls', async t => {
  const s = await serve()
  t.after(s.close)
  const { root } = tabFixture()
  await s.control('register', { id: 'demo', title: 'Demo', root })
  assert.deepEqual(await (await s.control('show', { tab: 'nope' })).json(), { isOpened: false, reason: 'no tab "nope"' })
  assert.deepEqual(await (await s.control('show', { tab: 'demo', select: 'a' })).json(), { isOpened: true, how: 'opened' })
  assert.equal(s.opened.length, 1)
  assert.match(s.opened[0], new RegExp(`^http://127\\.0\\.0\\.1:${s.port}/\\?t=${TOKEN}&tab=demo&want=1&select=a$`))
  // The window polls: the next show switches it, and opens nothing.
  await s.page('/api/state')
  assert.deepEqual(await (await s.control('show', { tab: 'demo', select: 'b' })).json(), { isOpened: true, how: 'reused' })
  assert.equal(s.opened.length, 1)
  assert.deepEqual((await (await s.page('/api/state')).json()).want, { tab: 'demo', select: 'b', id: 2 })
  // A window that stopped polling (closed) gets a new one.
  s.tick(5000)
  assert.deepEqual(await (await s.control('show', {})).json(), { isOpened: true, how: 'opened' })
  assert.equal(s.opened.length, 2)
})

test('a tab\'s server module gets its data and requests; a broken one costs only its own tab', async t => {
  const logs = []
  const s = await serve({ log: line => logs.push(line) })
  t.after(s.close)
  const good = tabFixture()
  fs.writeFileSync(
    path.join(good.dir, 'server.mjs'),
    `export default () => { let data = null
      return {
        update(d) { data = d },
        handle(req, res, sub) {
          if (sub === 'data') { res.end(JSON.stringify(data)); return true }
          if (sub === 'boom') throw new Error('boom')
          return false
        },
      } }`,
  )
  const bad = tabFixture()
  fs.writeFileSync(path.join(bad.dir, 'server.mjs'), 'throw new Error("cannot load")')
  await s.control('register', { id: 'good', title: 'Good', root: good.root, server: path.join(good.dir, 'server.mjs') })
  const r = await (await s.control('register', { id: 'bad', title: 'Bad', root: bad.root, server: path.join(bad.dir, 'server.mjs') })).json()
  assert.match(r.error, /cannot load/)
  await s.control('data', { tab: 'good', data: { n: 7 } })
  assert.deepEqual(await (await s.page('/tab/good/api/data')).json(), { n: 7 })
  assert.equal((await s.page('/tab/good/api/other')).status, 404)
  assert.equal((await s.page('/tab/good/api/boom')).status, 500)
  assert.equal((await s.page('/tab/bad/api/anything')).status, 404)
  assert.equal(await (await s.page('/tab/bad/')).text(), '<h1>tab</h1>')
  const tabs = (await (await s.page('/api/state')).json()).tabs
  assert.match(tabs.find(x => x.id === 'bad').error, /cannot load/)
  assert.ok(logs.some(l => l.includes('boom')))
})

test('a changed server module is imported afresh on register', async t => {
  const s = await serve()
  t.after(s.close)
  const { dir, root } = tabFixture()
  const file = path.join(dir, 'server.mjs')
  const write = (v, mtime) => {
    fs.writeFileSync(file, `export default () => ({ handle(req, res) { res.end('${v}'); return true } })`)
    fs.utimesSync(file, mtime, mtime)
  }
  write('v1', 1000)
  await s.control('register', { id: 'demo', title: 'Demo', root, server: file })
  assert.equal(await (await s.page('/tab/demo/api/x')).text(), 'v1')
  write('v2', 2000)
  await s.control('register', { id: 'demo', title: 'Demo', root, server: file })
  assert.equal(await (await s.page('/tab/demo/api/x')).text(), 'v2')
})
