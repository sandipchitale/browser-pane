// The editors' server module, shared by three tabs: Plugins (plugin/marketplace editor), MCP (MCP
// server editor) and Cockpit (a live view of the session). browser-pane's server imports it once and
// calls its default export per tab; each tab answers only its own routes under /tab/<id>/api/.
//
// It shells out to the `claude` CLI for a fixed list of actions with validated arguments, argv only,
// never a shell. The window's requests are already checked by browser-pane (token cookie, Host, origin).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as mcp from './mcp-lib.mjs'
import * as cockpit from './cockpit-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const CSS = path.join(here, 'tailwind.css')
const CLAUDE = process.env.CLAUDE_BIN ?? 'claude'
const SCOPES = new Set(['user', 'project', 'local'])
// A plugin or marketplace name; never one that starts with a dash, which the CLI would read as an option.
const ID = /^[\w.@][\w.@-]*$/
const MAX_BODY = 100_000

// What the mod tells every tab: the session and its folder (MCP project scope is per folder).
// usage: the context fill, rate-limit windows and cost the session last measured.
const session = { id: '', cwd: process.cwd(), lastEventKey: '', usage: null }

// ---- running the CLI (argv only, never a shell) ----
export function run(args, { timeoutMs = 120_000 } = {}) {
  return new Promise(resolve => {
    let out = ''
    let err = ''
    const child = spawn(CLAUDE, args, { cwd: session.cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', c => (out += c))
    child.stderr.on('data', c => (err += c))
    child.on('error', e => {
      clearTimeout(timer)
      resolve({ ok: false, code: -1, out, err: e.message })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, out, err })
    })
  })
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

const body = req =>
  new Promise(resolve => {
    let s = ''
    req.on('data', c => s.length < MAX_BODY && (s += c))
    req.on('end', () => resolve(s))
    req.on('error', () => resolve(''))
  })

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

// ---- Plugins tab: installed ∪ available, plus marketplaces ----
async function buildState() {
  const [list, mps] = await Promise.all([
    run(['plugin', 'list', '--json', '--available']),
    run(['plugin', 'marketplace', 'list', '--json']),
  ])
  if (!list.ok) throw new Error(list.err || list.out || 'claude plugin list failed')
  const data = JSON.parse(list.out)
  const configured = mps.ok ? JSON.parse(mps.out) : []

  const catalogs = new Map(configured.map(m => [m.name, readJson(path.join(m.installLocation ?? '', '.claude-plugin', 'marketplace.json'))]))
  const plugins = []
  for (const i of data.installed ?? []) {
    const at = i.id.lastIndexOf('@')
    const manifest = readJson(path.join(i.installPath ?? '', '.claude-plugin', 'plugin.json'))
    const listed = catalogs.get(at > 0 ? i.id.slice(at + 1) : '')?.plugins?.find(x => x.name === (at > 0 ? i.id.slice(0, at) : i.id))
    plugins.push({
      id: i.id,
      name: at > 0 ? i.id.slice(0, at) : i.id,
      marketplace: at > 0 ? i.id.slice(at + 1) : '',
      description: manifest?.description ?? listed?.description ?? '',
      version: i.version,
      installed: true,
      enabled: i.enabled,
      scope: i.scope,
      installPath: i.installPath,
      readFromFolder: i.readFromFolder,
      installedAt: i.installedAt,
      lastUpdated: i.lastUpdated,
      hasUserConfig: i.hasUserConfig === true,
    })
  }
  const have = new Set(plugins.map(p => p.id))
  for (const a of data.available ?? []) {
    if (have.has(a.pluginId)) continue
    plugins.push({
      id: a.pluginId,
      name: a.name,
      marketplace: a.marketplaceName,
      description: a.description ?? '',
      version: a.version,
      installed: false,
      enabled: false,
      installCount: a.installCount,
      source: a.source,
    })
  }

  const known = readJson(path.join(os.homedir(), '.claude', 'plugins', 'known_marketplaces.json'))
  const marketplaces = configured.map(m => {
    const mj = readJson(path.join(m.installLocation ?? '', '.claude-plugin', 'marketplace.json'))
    return {
      name: m.name,
      configured: true,
      source: m.source,
      repo: m.repo,
      path: m.path,
      url: m.url,
      installLocation: m.installLocation,
      lastUpdated: known?.[m.name]?.lastUpdated,
      owner: mj?.owner?.name,
      description: mj?.description ?? mj?.metadata?.description ?? '',
    }
  })
  const names = new Set(marketplaces.map(m => m.name))
  for (const p of plugins) {
    if (p.marketplace && !names.has(p.marketplace)) {
      names.add(p.marketplace)
      marketplaces.push({ name: p.marketplace, configured: false, description: 'Built-in catalog (not in your configured marketplaces).' })
    }
  }
  return { plugins, marketplaces, at: Date.now(), home: os.homedir() }
}

// The actions the Plugins tab may run: an allow-list, every argument validated.
export function actionArgs(b) {
  const scope = b.scope === undefined ? undefined : SCOPES.has(b.scope) ? b.scope : null
  if (scope === null) return null
  const withScope = args => (scope ? [...args, '--scope', scope] : args)
  switch (b.action) {
    case 'install':
      return ID.test(b.plugin ?? '') ? withScope(['plugin', 'install', b.plugin]) : null
    case 'uninstall':
      return ID.test(b.plugin ?? '') ? withScope(['plugin', 'uninstall', b.plugin]) : null
    case 'enable':
    case 'disable':
      return ID.test(b.plugin ?? '') ? withScope(['plugin', b.action, b.plugin]) : null
    case 'update':
      return ID.test(b.plugin ?? '') ? ['plugin', 'update', b.plugin] : null
    case 'marketplace-add': {
      const s = String(b.source ?? '').trim()
      return s && s.length < 500 && !s.startsWith('-') ? withScope(['plugin', 'marketplace', 'add', s]) : null
    }
    case 'marketplace-remove':
      return ID.test(b.marketplace ?? '') ? ['plugin', 'marketplace', 'remove', b.marketplace] : null
    case 'marketplace-update':
      return b.marketplace === undefined ? ['plugin', 'marketplace', 'update'] : ID.test(b.marketplace) ? ['plugin', 'marketplace', 'update', b.marketplace] : null
    default:
      return null
  }
}

async function pluginsRoute(req, res, url) {
  const sub = url.pathname
  if (req.method === 'GET' && sub === 'state') {
    try {
      return json(res, 200, await buildState())
    } catch (e) {
      return json(res, 500, { error: String(e.message ?? e) })
    }
  }
  if (req.method === 'GET' && sub === 'details') {
    const name = url.searchParams.get('name') ?? ''
    if (!ID.test(name)) return json(res, 400, { error: 'bad name' })
    const r = await run(['plugin', 'details', name], { timeoutMs: 30_000 })
    return json(res, 200, { ok: r.ok, text: (r.out || r.err).trim() })
  }
  if (req.method === 'POST' && sub === 'action') {
    let b
    try {
      b = JSON.parse(await body(req))
    } catch {}
    const args = b && actionArgs(b)
    if (!args) return json(res, 400, { error: 'unknown or invalid action' })
    const r = await run(args)
    return json(res, 200, { ok: r.ok, text: (r.out + (r.err ? '\n' + r.err : '')).trim(), args: args.slice(1) })
  }
  return false
}

// ---- MCP tab ----
const findServer = (name, scope) => mcp.readConfig(os.homedir(), session.cwd).servers.find(x => x.name === name && x.scope === scope)

async function mcpAction(req, res) {
  let b
  try {
    b = JSON.parse(await body(req))
  } catch {}
  if (!b || typeof b !== 'object') return json(res, 400, { error: 'bad request' })
  const scope = b.scope
  const named = typeof b.name === 'string' && mcp.NAME.test(b.name) && mcp.SCOPES.has(scope)
  if (b.action === 'get') {
    if (typeof b.name !== 'string' || !mcp.ANY_NAME.test(b.name)) return json(res, 400, { error: 'bad name' })
    const r = await run(['mcp', 'get', b.name], { timeoutMs: 60_000 })
    return json(res, 200, { ok: r.ok, text: (r.out || r.err).trim() })
  }
  if (!named) return json(res, 400, { error: 'name or scope invalid' })
  if (b.action === 'remove') {
    const r = await run(mcp.removeArgs(b.name, scope))
    return json(res, 200, { ok: r.ok, text: (r.out + r.err).trim() })
  }
  if (b.action === 'add' || b.action === 'edit') {
    const v = mcp.validateConfig(b.config)
    if (v.error) return json(res, 400, { error: v.error })
    const before = findServer(b.name, scope)
    if (b.action === 'add' && before) return json(res, 409, { error: `${b.name} already exists in ${scope} scope` })
    if (b.action === 'edit' && !before) return json(res, 404, { error: `${b.name} not found in ${scope} scope` })
    let log = ''
    if (before) {
      const rm = await run(mcp.removeArgs(b.name, scope))
      log += rm.out + rm.err
      if (!rm.ok) return json(res, 200, { ok: false, text: log.trim() })
    }
    const add = await run(mcp.addJsonArgs(b.name, scope, v.config))
    log += add.out + add.err
    if (add.ok) return json(res, 200, { ok: true, text: log.trim() })
    if (before) {
      const back = await run(mcp.addJsonArgs(b.name, scope, before.config))
      log += '\nRolled back to the previous definition: ' + (back.ok ? 'ok' : 'FAILED ' + back.err)
    }
    return json(res, 200, { ok: false, text: log.trim() })
  }
  return json(res, 400, { error: 'unknown action' })
}

// No CLI exists for enable/disable. Project (.mcp.json) servers: approval lists in the project's
// .claude/settings.local.json. Everything else: one array in ~/.claude.json (with a backup).
// Both are read, changed in that one key, written to a temp file and renamed.
function writeAtomic(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, { mode })
  fs.renameSync(tmp, file)
}

async function mcpToggle(req, res) {
  let b
  try {
    b = JSON.parse(await body(req))
  } catch {}
  if (!b || typeof b.name !== 'string' || !mcp.ANY_NAME.test(b.name) || typeof b.disabled !== 'boolean') return json(res, 400, { error: 'bad request' })
  const cwd = session.cwd
  try {
    const isProjectFile = mcp.readConfig(os.homedir(), cwd).servers.some(x => x.name === b.name && x.scope === 'project')
    if (isProjectFile) {
      const file = path.join(cwd, '.claude', 'settings.local.json')
      const next = mcp.toggledSettings(mcp.readJson(file) ?? {}, b.name, b.disabled)
      writeAtomic(file, JSON.stringify(next, null, 2) + '\n')
      return json(res, 200, { ok: true, text: `${b.name} ${b.disabled ? 'rejected' : 'approved'} in ${file}` })
    }
    const file = path.join(os.homedir(), '.claude.json')
    const text = fs.readFileSync(file, 'utf8')
    const next = mcp.toggled(JSON.parse(text), cwd, b.name, b.disabled)
    const mode = fs.statSync(file).mode & 0o777
    fs.writeFileSync(`${file}.bak-${Date.now()}`, text, { mode })
    writeAtomic(file, JSON.stringify(next, null, 2), mode)
    const dir = path.dirname(file)
    const baks = fs.readdirSync(dir).filter(f => f.startsWith('.claude.json.bak-')).sort()
    for (const old of baks.slice(0, -5)) fs.rmSync(path.join(dir, old), { force: true })
    return json(res, 200, { ok: true, text: `${b.name} ${b.disabled ? 'disabled' : 'enabled'} for ${cwd}` })
  } catch (e) {
    return json(res, 500, { ok: false, text: String(e.message ?? e) })
  }
}

async function mcpRoute(req, res, url) {
  const sub = url.pathname
  if (req.method === 'GET' && sub === 'mcp/config') return json(res, 200, { ...mcp.readConfig(os.homedir(), session.cwd), home: os.homedir() })
  if (req.method === 'GET' && sub === 'mcp/health') {
    const r = await run(['mcp', 'list'], { timeoutMs: 60_000 })
    return json(res, 200, { ok: r.ok, health: mcp.parseList(r.out), error: r.ok ? '' : (r.err || r.out).trim() })
  }
  if (req.method === 'POST' && sub === 'mcp/action') return mcpAction(req, res)
  if (req.method === 'POST' && sub === 'mcp/toggle') return mcpToggle(req, res)
  return false
}

// ---- Cockpit tab ----
// Two sources: the saved transcript (~/.claude/projects/*/<id>.jsonl, tailed) and a live overlay of the
// hook events the mod sends (the file can lag the running session). cockpit.merge lets the file win.
const watched = { file: '', offset: 0, rest: '', state: cockpit.createState(), live: cockpit.createState(), liveEvents: 0, id: '' }

function findTranscript(id) {
  const root = path.join(os.homedir(), '.claude', 'projects')
  try {
    for (const dir of fs.readdirSync(root)) {
      const file = path.join(root, dir, `${id}.jsonl`)
      if (fs.existsSync(file)) return file
    }
  } catch {}
  return ''
}

// The session the cockpit follows; a new one starts from nothing.
function follow(id) {
  if (!cockpit.SESSION_ID.test(id) || watched.id === id) return
  Object.assign(watched, { file: '', offset: 0, rest: '', state: cockpit.createState(), live: cockpit.createState(), liveEvents: 0, id })
}

// Reads only what was appended since the last call.
function pull() {
  if (!watched.id) return
  if (!watched.file) watched.file = findTranscript(watched.id)
  if (!watched.file) return
  const size = fs.statSync(watched.file).size
  if (size < watched.offset) Object.assign(watched, { offset: 0, rest: '', state: cockpit.createState() })
  if (size === watched.offset) return
  const fd = fs.openSync(watched.file, 'r')
  try {
    const buf = Buffer.alloc(size - watched.offset)
    fs.readSync(fd, buf, 0, buf.length, watched.offset)
    watched.offset = size
    const lines = (watched.rest + buf.toString('utf8')).split('\n')
    watched.rest = lines.pop() ?? ''
    cockpit.feed(watched.state, lines)
  } finally {
    fs.closeSync(fd)
  }
}

function cockpitRoute(req, res, url) {
  const sub = url.pathname
  if (req.method === 'GET' && sub === 'cockpit/state') {
    if (!watched.id) return json(res, 200, { empty: true, current: '' })
    try {
      pull()
      const fileSnap = cockpit.snapshot(watched.state)
      const snap = watched.liveEvents ? cockpit.merge(fileSnap, cockpit.snapshot(watched.live)) : fileSnap
      let savedAt
      try {
        savedAt = watched.file ? fs.statSync(watched.file).mtimeMs : undefined
      } catch {}
      return json(res, 200, { current: watched.id, id: watched.id, found: !!watched.file || watched.liveEvents > 0, savedAt, liveEvents: watched.liveEvents, usage: session.usage, ...snap })
    } catch (e) {
      return json(res, 500, { error: String(e.message ?? e) })
    }
  }
  if (req.method === 'GET' && sub === 'cockpit/search') {
    if (!watched.id) return json(res, 200, { hits: [] })
    pull()
    const q = url.searchParams.get('q') ?? ''
    return json(res, 200, { hits: cockpit.search(watched.state, q).concat(watched.liveEvents ? cockpit.search(watched.live, q) : []).slice(0, 50) })
  }
  return false
}

// What the mod sends (update): the session, its folder, what it last measured, and the cockpit's live
// events one at a time.
// browser-pane resends the latest data when its server restarts, so an event already fed is skipped.
export function receive(data) {
  if (!data || typeof data !== 'object') return
  if (typeof data.cwd === 'string' && path.isAbsolute(data.cwd)) session.cwd = data.cwd
  if (data.usage && typeof data.usage === 'object') session.usage = data.usage
  if (typeof data.session === 'string' && cockpit.SESSION_ID.test(data.session)) {
    session.id = data.session
    follow(data.session)
  }
  if (data.event && typeof data.key === 'string' && data.key !== session.lastEventKey) {
    session.lastEventKey = data.key
    const rec = cockpit.fromEvent(data.event)
    if (rec && watched.id) {
      cockpit.feed(watched.live, [JSON.stringify(rec)])
      watched.liveEvents++
    }
  }
}

const ROUTES = { plugins: pluginsRoute, mcp: mcpRoute, cockpit: cockpitRoute }

export default function editors({ id }) {
  const route = ROUTES[id]
  return {
    update: receive,
    async handle(req, res, sub) {
      if (req.method === 'GET' && sub === 'tailwind.css') {
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(fs.readFileSync(CSS))
        return true
      }
      if (!route) return false
      // `sub` is the path below api/; the query is on the request's own URL.
      const { searchParams } = new URL(req.url, 'http://tab/')
      const answered = await route(req, res, { pathname: sub, searchParams })
      return answered !== false
    },
  }
}
