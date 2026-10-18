// The tab's server module. browser-pane's shared server imports it and calls the default export once
// for the tab; it answers the tab's requests under /tab/<id>/api/. It runs in Node, so it can read
// files, run commands (argv arrays, never a shell) and keep state for the session.
//
// browser-pane has already checked every request (token cookie, Host, origin) before it gets here.

const MAX_BODY = 10_000

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

const body = req =>
  new Promise(resolve => {
    let s = ''
    req.on('data', c => s.length < MAX_BODY && (s += c))
    req.on('end', () => resolve(s))
    req.on('error', () => resolve(''))
  })

export default function create({ id }) {
  // The latest data the mod sent (show({ data }) or update), and what the page sent.
  let data = {}
  const notes = []

  return {
    // Called with each show/update's data, latest wins. browser-pane sends the latest again when its
    // server restarts, so treat it as state, not as an event.
    update(next) {
      if (next && typeof next === 'object') data = next
    },

    // `sub` is the path below api/, with no query: read the query from req.url. Return false for 404.
    async handle(req, res, sub) {
      if (req.method === 'GET' && sub === 'info') {
        json(res, 200, { tab: id, data, notes })
        return true
      }
      if (req.method === 'POST' && sub === 'notes') {
        let text = ''
        try {
          text = String(JSON.parse((await body(req)) || '{}').text ?? '').slice(0, 200)
        } catch {}
        if (!text) {
          json(res, 400, { error: 'a note needs text' })
          return true
        }
        notes.push({ text, at: new Date().toISOString() })
        json(res, 200, { notes })
        return true
      }
      return false
    },
  }
}
