// The browser-pane server's routes, registry and checks, apart from the process around them so tests can
// drive them. Zero dependencies.
//
// Two callers, two keys. The mod calls /control/* with the token in a header. The window's pages carry
// it as a cookie named for this port, set once from the URL the window was opened on. Every request must
// name this server's own Host, which refuses DNS rebinding.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const TAB_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
export const GUIDE = 'guide'
const MAX_FILES = 5000
const MAX_DEPTH = 8
const MAX_BODY = 1_000_000
const RESCAN_MS = 1000

const MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json; charset=utf-8',
}
export const mimeOf = file => MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream'

const realpath = p => {
  try {
    return fs.realpathSync(p)
  } catch {
    return undefined
  }
}
const isInside = (file, root) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

// The files a tab may serve: everything under its root but dotfiles, and links that lead outside it.
export function listFiles(root) {
  const files = new Map()
  const realRoot = realpath(root)
  if (!realRoot) return files
  const walk = (dir, rel, depth) => {
    if (depth > MAX_DEPTH || files.size >= MAX_FILES) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || files.size >= MAX_FILES) continue
      const abs = path.join(dir, entry.name)
      const real = realpath(abs)
      if (!real || !isInside(real, realRoot)) continue
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      let st
      try {
        st = fs.statSync(real)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(abs, relPath, depth + 1)
      else if (st.isFile()) files.set(relPath, abs)
    }
  }
  walk(realRoot, '', 0)
  return files
}

// A request path below /tab/<id>/ as the key of the tab's file list, or undefined for anything that
// tries to leave it: `..`, dot segments, encoded slashes or backslashes, NUL.
export function relativeKey(rest) {
  if (rest === '' || rest.endsWith('/')) rest += 'index.html'
  const parts = []
  for (const raw of rest.split('/')) {
    let part
    try {
      part = decodeURIComponent(raw)
    } catch {
      return undefined
    }
    if (part === '' || part.startsWith('.') || /[\\/\0]/.test(part)) return undefined
    parts.push(part)
  }
  return parts.join('/')
}

export const cookieName = port => `bp_${port}`

function readCookie(header, name) {
  for (const pair of String(header ?? '').split(';')) {
    const i = pair.indexOf('=')
    if (i > 0 && pair.slice(0, i).trim() === name) return pair.slice(i + 1).trim()
  }
  return undefined
}

const body = req =>
  new Promise((resolve, reject) => {
    let s = ''
    req.on('data', c => {
      s += c
      if (s.length > MAX_BODY) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(s))
    req.on('error', reject)
  })

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

const end = (res, code) => {
  res.writeHead(code)
  res.end()
}

const isAbsolute = p => typeof p === 'string' && path.isAbsolute(p)

/**
 * The server's request handler and state.
 *
 * `openWindow(url)` resolves true when it opened a window on `url`. A page that polled within `liveMs`
 * is an open window: a show then switches it rather than opening a second.
 */
export function createApp({ token, shellDir, openWindow, log = () => {}, now = Date.now, liveMs = 5000 }) {
  let port = 0
  let lastPoll = 0
  let lastControl = now()
  let want = { tab: GUIDE, select: undefined, id: 0 }
  // id -> { tab, files, scannedAt, module, moduleKey, moduleError, data, hasData }
  const tabs = new Map()

  async function loadModule(entry) {
    const file = entry.tab.server
    if (!file) {
      entry.module = undefined
      entry.moduleKey = undefined
      entry.moduleError = undefined
      return
    }
    let mtime = 0
    try {
      mtime = fs.statSync(file).mtimeMs
    } catch (error) {
      entry.module = undefined
      entry.moduleError = `can't read ${file}: ${error.message}`
      return
    }
    // Node caches modules by URL, so a changed file is imported under a new one.
    const key = `${file}?v=${mtime}`
    if (entry.moduleKey === key && !entry.moduleError) return
    try {
      const mod = await import(`${pathToFileURL(file).href}?v=${mtime}`)
      const made = typeof mod.default === 'function' ? await mod.default({ id: entry.tab.id, root: entry.tab.root }) : undefined
      entry.module = made && typeof made === 'object' ? made : undefined
      entry.moduleKey = key
      entry.moduleError = entry.module ? undefined : `${file} default-exports no function returning { update, handle }`
    } catch (error) {
      entry.module = undefined
      entry.moduleKey = undefined
      entry.moduleError = `${file}: ${error?.message ?? error}`
    }
    if (entry.moduleError) log(`tab ${entry.tab.id}: ${entry.moduleError}`)
  }

  async function sendData(entry) {
    if (!entry.hasData || typeof entry.module?.update !== 'function') return
    try {
      await entry.module.update(entry.data)
    } catch (error) {
      log(`tab ${entry.tab.id}: update failed: ${error?.message ?? error}`)
    }
  }

  async function register(tab) {
    if (!tab || !TAB_ID.test(String(tab.id)) || tab.id === GUIDE) return 'bad tab id'
    if (typeof tab.title !== 'string' || !isAbsolute(tab.root)) return 'a tab needs a title and an absolute root'
    if (tab.server !== undefined && !isAbsolute(tab.server)) return 'a tab server must be an absolute path'
    const clean = { id: tab.id, title: tab.title, root: tab.root }
    if (tab.server !== undefined) clean.server = tab.server
    if (typeof tab.description === 'string') clean.description = tab.description
    if (tab.pinned === true) clean.pinned = true
    const entry = tabs.get(tab.id) ?? { data: undefined, hasData: false }
    entry.tab = clean
    entry.files = listFiles(clean.root)
    entry.scannedAt = now()
    tabs.set(tab.id, entry)
    await loadModule(entry)
    await sendData(entry)
    return undefined
  }

  // A file the tab's list names; on a miss the list is read again (files are added while a tab is
  // written), at most once a second.
  function fileFor(entry, key) {
    let file = entry.files.get(key)
    if (!file && now() - entry.scannedAt >= RESCAN_MS) {
      entry.files = listFiles(entry.tab.root)
      entry.scannedAt = now()
      file = entry.files.get(key)
    }
    if (!file) return undefined
    // The file may have become a link since the list was read.
    const real = realpath(file)
    const realRoot = realpath(entry.tab.root)
    return real && realRoot && isInside(real, realRoot) ? real : undefined
  }

  function serveFile(res, file, cacheControl = 'no-cache') {
    let st
    try {
      st = fs.statSync(file)
    } catch {
      return end(res, 404)
    }
    res.writeHead(200, {
      'content-type': mimeOf(file),
      'content-length': st.size,
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
    })
    fs.createReadStream(file).pipe(res)
  }

  // A tab whose folder is gone (its mod was removed this session) is left out; the mod can't take it back.
  const tabList = () =>
    [...tabs.values()]
      .filter(({ tab }) => fs.existsSync(tab.root))
      .map(({ tab, moduleError }) => ({
        id: tab.id,
        title: tab.title,
        description: tab.description ?? '',
        ...(tab.pinned ? { pinned: true } : {}),
        ...(moduleError ? { error: moduleError } : {}),
      }))

  async function control(req, res, name) {
    lastControl = now()
    if (name === 'ping') return end(res, 204)
    let b
    try {
      b = JSON.parse((await body(req)) || '{}')
    } catch {
      return json(res, 400, { ok: false, reason: 'bad JSON' })
    }
    if (name === 'register') {
      const problem = await register(b)
      return problem ? json(res, 400, { ok: false, reason: problem }) : json(res, 200, { ok: true, error: tabs.get(b.id).moduleError })
    }
    if (name === 'data') {
      const entry = tabs.get(b.tab)
      if (!entry) return json(res, 404, { ok: false, reason: `no tab "${b.tab}"` })
      entry.data = b.data
      entry.hasData = true
      await sendData(entry)
      return json(res, 200, { ok: true })
    }
    if (name === 'show') {
      const tab = b.tab ?? GUIDE
      if (tab !== GUIDE && !tabs.has(tab)) return json(res, 200, { isOpened: false, reason: `no tab "${tab}"` })
      want = { tab, select: typeof b.select === 'string' ? b.select : undefined, id: want.id + 1 }
      if (now() - lastPoll < liveMs) return json(res, 200, { isOpened: true, how: 'reused' })
      const query = new URLSearchParams({ t: token, tab, want: String(want.id) })
      if (want.select !== undefined) query.set('select', want.select)
      const isOpened = await openWindow(`http://127.0.0.1:${port}/?${query}`)
      return json(res, 200, isOpened ? { isOpened: true, how: 'opened' } : { isOpened: false, reason: 'no browser could be started' })
    }
    return end(res, 404)
  }

  async function handler(req, res) {
    res.setHeader('x-frame-options', 'SAMEORIGIN')
    if (req.headers.host !== `127.0.0.1:${port}`) return end(res, 421)
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    const control_ = /^\/control\/([a-z]+)$/.exec(url.pathname)
    if (control_) {
      if (req.method !== 'POST' || req.headers['x-browser-pane-token'] !== token) return end(res, 403)
      return control(req, res, control_[1])
    }
    // A cookie for 127.0.0.1 goes to every port on it, so a page some other local server serves could
    // send ours along. Browsers say where a request came from: only our own pages, or the window's
    // first navigation (none), may use the cookie.
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return end(res, 403)
    // The window's first request carries the token in its URL: it becomes this port's cookie.
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('t') === token) {
      url.searchParams.delete('t')
      res.writeHead(303, {
        'set-cookie': `${cookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        location: `/${url.searchParams.size ? `?${url.searchParams}` : ''}`,
        'cache-control': 'no-store',
      })
      return res.end()
    }
    if (readCookie(req.headers.cookie, cookieName(port)) !== token) return end(res, 403)
    if (req.method === 'GET' && url.pathname === '/') return serveFile(res, path.join(shellDir, 'index.html'))
    if (req.method === 'GET' && url.pathname === '/bp/client.js') return serveFile(res, path.join(shellDir, 'client.js'))
    if (req.method === 'GET' && url.pathname === '/api/state') {
      lastPoll = now()
      return json(res, 200, { tabs: tabList(), want })
    }
    const inTab = /^\/tab\/([^/]+)\/(.*)$/.exec(url.pathname)
    const entry = inTab && tabs.get(inTab[1])
    if (!entry) return end(res, 404)
    const rest = inTab[2]
    if (rest.startsWith('api/')) {
      if (typeof entry.module?.handle !== 'function') return end(res, 404)
      try {
        const handled = await entry.module.handle(req, res, rest.slice(4))
        if (!handled && !res.headersSent) end(res, 404)
      } catch (error) {
        log(`tab ${entry.tab.id}: ${req.method} ${rest}: ${error?.message ?? error}`)
        if (!res.headersSent) json(res, 500, { ok: false, reason: 'the tab server failed' })
        else res.end()
      }
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405)
    const key = relativeKey(rest)
    const file = key && fileFor(entry, key)
    if (!file) return end(res, 404)
    return serveFile(res, file)
  }

  return {
    handler,
    setPort: p => {
      port = p
    },
    lastControl: () => lastControl,
    want: () => want,
    tabs: () => tabList(),
  }
}
