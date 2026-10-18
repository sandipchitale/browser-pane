// The Images tab's server module: browser-pane's server imports it and sends it the tab's requests
// under /tab/images/api/. The mod tells it the session and the dropped files' paths (update); the page
// names an image only by its number, so only a file on the list is ever served, opened or revealed.
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import * as lib from './images-lib.mjs'

const MAX_BODY = 10_000

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

const body = req =>
  new Promise(resolve => {
    let s = ''
    req.on('data', c => s.length < MAX_BODY && (s += c))
    req.on('end', () => resolve(s))
    req.on('error', () => resolve(''))
  })

// argv only, never a shell. Resolves true when the command worked.
function attempt({ argv, trustExit }) {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0 || trustExit === true))
  })
}

async function firstOk(attempts) {
  for (const a of attempts) if (await attempt(a)) return true
  return false
}

export default function images() {
  let session = ''
  let origins = {}
  const list = () => lib.buildList(session, origins)

  return {
    update(data) {
      if (!data || typeof data !== 'object') return
      if (typeof data.session === 'string' && lib.SESSION_ID.test(data.session)) session = data.session
      if (data.origins && typeof data.origins === 'object') origins = data.origins
    },

    async handle(req, res, sub) {
      if (req.method === 'GET' && sub === 'images') {
        json(res, 200, { platform: process.platform, images: list() })
        return true
      }
      const image = /^image\/(\d+)$/.exec(sub)
      if (req.method === 'GET' && image) {
        const row = list().find(r => r.n === Number(image[1]))
        if (!row) return false
        res.writeHead(200, { 'content-type': row.mime, 'content-length': row.size, 'cache-control': 'no-store' })
        fs.createReadStream(row.path).pipe(res)
        return true
      }
      if (req.method === 'POST' && (sub === 'open' || sub === 'reveal')) {
        let n = 0
        try {
          n = Number(JSON.parse((await body(req)) || '{}').n)
        } catch {}
        const row = list().find(r => r.n === n)
        if (!row) {
          json(res, 404, { ok: false, error: 'not found' })
          return true
        }
        const ok = await firstOk(sub === 'reveal' ? lib.revealAttempts(row.path) : lib.openAttempts(row.path))
        json(res, 200, { ok })
        return true
      }
      return false
    },
  }
}
