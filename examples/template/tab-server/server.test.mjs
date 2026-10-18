// node --test tab-server/
// The tab's server module behind a small HTTP server that calls it as browser-pane's does: the path
// below /tab/<id>/api/ as `sub`, false for 404.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import create from './server.mjs'

async function serve() {
  const tab = create({ id: 'template', root: '/unused' })
  const server = http.createServer(async (req, res) => {
    const sub = new URL(req.url, 'http://x').pathname.replace(/^\/tab\/template\/api\//, '')
    if (!(await tab.handle(req, res, sub))) {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/tab/template/api/`
  return { tab, base, close: () => server.close() }
}

test('info answers the latest data the mod sent', async t => {
  const s = await serve()
  t.after(s.close)
  assert.deepEqual(await (await fetch(s.base + 'info')).json(), { tab: 'template', data: {}, notes: [] })
  s.tab.update({ session: 's1' })
  s.tab.update({ session: 's2', shownAt: 'now' })
  assert.deepEqual((await (await fetch(s.base + 'info')).json()).data, { session: 's2', shownAt: 'now' })
})

test('notes are kept, and a note needs text', async t => {
  const s = await serve()
  t.after(s.close)
  const post = text => fetch(s.base + 'notes', { method: 'POST', body: JSON.stringify({ text }) })
  assert.equal((await post('')).status, 400)
  assert.equal((await (await post('first')).json()).notes[0].text, 'first')
  assert.deepEqual((await (await fetch(s.base + 'info')).json()).notes.map(n => n.text), ['first'])
})

test('anything else is 404', async t => {
  const s = await serve()
  t.after(s.close)
  assert.equal((await fetch(s.base + 'nope')).status, 404)
  assert.equal((await fetch(s.base + 'notes')).status, 404)
})
