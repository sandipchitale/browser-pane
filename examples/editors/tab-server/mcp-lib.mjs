// Pure helpers for the MCP editor: parsing `claude mcp list`, reading and validating
// config, building CLI arguments. No I/O except readConfig's file reads.
import fs from 'node:fs'
import path from 'node:path'

export const NAME = /^[\w.-]{1,100}$/
export const ANY_NAME = /^[\w .:@-]{1,100}$/ // plugin and connector servers: "plugin:a:b", "claude.ai Gmail"
export const SCOPES = new Set(['user', 'project', 'local'])

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

// `name: target - ✔ Connected` | `… - ✘ Failed to connect — reason` | `… - ⏸ Pending approval`
export function parseList(text) {
  const out = []
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    const colon = line.indexOf(': ')
    const dash = line.lastIndexOf(' - ')
    if (colon <= 0 || dash <= colon) continue
    const status = line.slice(dash + 3).trim()
    const sym = status[0]
    const kind = sym === '✔' ? 'connected' : sym === '✘' ? 'failed' : sym === '⏸' ? 'pending' : /auth/i.test(status) ? 'needs-auth' : 'unknown'
    const reason = status.replace(/^\S+\s*/, '').replace(/^Failed to connect\s*—?\s*/, '')
    out.push({ name: line.slice(0, colon), target: line.slice(colon + 2, dash), status: kind, reason: kind === 'connected' ? '' : reason.length > 300 ? reason.slice(0, 300) + '…' : reason })
  }
  return out
}

export function kindOf(name) {
  return name.startsWith('plugin:') ? 'plugin' : name.startsWith('claude.ai ') ? 'connector' : 'other'
}

// Reads user, local and project servers plus the enable/disable switches.
// .mcp.json approvals live in settings files (Claude Code moves them out of ~/.claude.json):
// <project>/.claude/settings.local.json is the one we write; settings.json files and the legacy
// ~/.claude.json project entry are read too.
export function readConfig(home, cwd) {
  const cj = readJson(path.join(home, '.claude.json')) ?? {}
  const proj = cj.projects?.[cwd] ?? {}
  const mcpjson = readJson(path.join(cwd, '.mcp.json'))?.mcpServers ?? {}
  const sources = [proj, readJson(path.join(cwd, '.claude', 'settings.local.json')) ?? {}, readJson(path.join(cwd, '.claude', 'settings.json')) ?? {}, readJson(path.join(home, '.claude', 'settings.json')) ?? {}]
  const union = key => new Set(sources.flatMap(o => o[key] ?? []))
  const enabledJ = union('enabledMcpjsonServers')
  const disabledJ = union('disabledMcpjsonServers')
  const enableAll = sources.slice(1).some(o => o.enableAllProjectMcpServers === true)
  const disabled = new Set(proj.disabledMcpServers ?? [])
  const servers = []
  for (const [name, config] of Object.entries(cj.mcpServers ?? {})) servers.push({ name, scope: 'user', config, disabled: disabled.has(name) })
  for (const [name, config] of Object.entries(mcpjson)) {
    const approval = disabledJ.has(name) ? 'disabled' : enabledJ.has(name) || enableAll ? 'enabled' : 'pending'
    servers.push({ name, scope: 'project', config, disabled: approval === 'disabled', approval })
  }
  for (const [name, config] of Object.entries(proj.mcpServers ?? {})) servers.push({ name, scope: 'local', config, disabled: disabled.has(name) })
  return { cwd, servers, disabledNames: [...disabled] }
}

const isStrMap = o => o && typeof o === 'object' && !Array.isArray(o) && Object.values(o).every(v => typeof v === 'string')

// Returns { config } (normalised, only known keys) or { error }.
export function validateConfig(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { error: 'config must be an object' }
  const type = c.type ?? 'stdio'
  if (type === 'stdio') {
    if (typeof c.command !== 'string' || !c.command.trim()) return { error: 'command is required' }
    const args = c.args ?? []
    if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) return { error: 'args must be a list of strings' }
    if (c.env !== undefined && !isStrMap(c.env)) return { error: 'env must map names to strings' }
    const config = { type: 'stdio', command: c.command.trim(), args }
    if (c.env && Object.keys(c.env).length) config.env = c.env
    return { config }
  }
  if (type === 'http' || type === 'sse') {
    let u
    try { u = new URL(c.url) } catch { return { error: 'url is not valid' } }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'url must be http or https' }
    if (c.headers !== undefined && !isStrMap(c.headers)) return { error: 'headers must map names to strings' }
    const config = { type, url: c.url }
    if (c.headers && Object.keys(c.headers).length) config.headers = c.headers
    return { config }
  }
  return { error: 'unknown transport: ' + type }
}

export const removeArgs = (name, scope) => ['mcp', 'remove', name, '-s', scope]
export const addJsonArgs = (name, scope, config) => ['mcp', 'add-json', name, JSON.stringify(config), '-s', scope]

// Returns a new ~/.claude.json object with one server's per-project disabled switch changed.
export function toggled(cj, cwd, name, disabled) {
  const next = structuredClone(cj)
  next.projects ??= {}
  const p = (next.projects[cwd] ??= {})
  const set = new Set(p.disabledMcpServers ?? [])
  disabled ? set.add(name) : set.delete(name)
  p.disabledMcpServers = [...set]
  return next
}

// Returns a new settings object with one .mcp.json server approved (disabled=false) or rejected.
export function toggledSettings(settings, name, disabled) {
  const next = structuredClone(settings ?? {})
  const edit = (key, on) => {
    const set = new Set(next[key] ?? [])
    on ? set.add(name) : set.delete(name)
    next[key] = [...set]
  }
  edit('disabledMcpjsonServers', disabled)
  edit('enabledMcpjsonServers', !disabled)
  return next
}
