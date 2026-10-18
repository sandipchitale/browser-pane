import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseList, validateConfig, readConfig, toggled, toggledSettings, addJsonArgs, kindOf } from './mcp-lib.mjs'

test('parseList handles connectors, plugin servers, failures and pending', () => {
  const r = parseList(`Checking MCP server health…

claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
chrome-devtools: npx chrome-devtools-mcp@latest --autoConnect - ✔ Connected
idea: http://127.0.0.1:64342/stream (HTTP) - ✘ Failed to connect — ECONNREFUSED: ECONNREFUSED: Unable to connect.
plugin:stts:stts-mcp: node x.js - ⏸ Pending approval`)
  assert.deepEqual(r.map(x => [x.name, x.status]), [
    ['claude.ai Gmail', 'connected'], ['chrome-devtools', 'connected'], ['idea', 'failed'], ['plugin:stts:stts-mcp', 'pending'],
  ])
  assert.equal(r[2].target, 'http://127.0.0.1:64342/stream (HTTP)')
  assert.match(r[2].reason, /^ECONNREFUSED/)
  assert.equal(kindOf(r[0].name), 'connector')
  assert.equal(kindOf(r[3].name), 'plugin')
})

test('validateConfig normalises and rejects', () => {
  assert.deepEqual(validateConfig({ command: ' npx ', args: ['a'], junk: 1 }).config, { type: 'stdio', command: 'npx', args: ['a'] })
  assert.ok(validateConfig({ type: 'stdio' }).error)
  assert.ok(validateConfig({ type: 'http', url: 'file:///x' }).error)
  assert.ok(validateConfig({ type: 'http', url: 'https://x.dev/mcp', headers: { A: 1 } }).error)
  assert.deepEqual(validateConfig({ type: 'sse', url: 'https://x.dev/s', headers: {} }).config, { type: 'sse', url: 'https://x.dev/s' })
  assert.ok(validateConfig({ type: 'ws' }).error)
})

test('readConfig maps scopes and switches', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'))
  const cwd = path.join(home, 'proj')
  fs.mkdirSync(cwd)
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { u1: { type: 'http', url: 'https://u' } },
    projects: { [cwd]: { mcpServers: { l1: { command: 'x' } }, disabledMcpServers: ['u1'] } },
  }))
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { p1: { command: 'y' }, p2: { command: 'z' }, p3: { command: 'w' } } }))
  fs.mkdirSync(path.join(cwd, '.claude'))
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['p1'], disabledMcpjsonServers: ['p3'], keep: 1 }))
  const { servers } = readConfig(home, cwd)
  const by = Object.fromEntries(servers.map(s => [s.name, s]))
  assert.equal(by.u1.scope, 'user'); assert.equal(by.u1.disabled, true)
  assert.equal(by.l1.scope, 'local'); assert.equal(by.l1.disabled, false)
  assert.equal(by.p1.approval, 'enabled'); assert.equal(by.p2.approval, 'pending'); assert.equal(by.p3.approval, 'disabled'); assert.equal(by.p3.disabled, true)
})

test('toggled changes only the one key and does not mutate its input', () => {
  const cj = { other: 1, projects: { '/p': { disabledMcpServers: ['a'], keep: true } } }
  const frozen = JSON.stringify(cj)
  const off = toggled(cj, '/p', 'b', true)
  assert.deepEqual(off.projects['/p'].disabledMcpServers.sort(), ['a', 'b'])
  assert.equal(off.projects['/p'].keep, true)
  assert.equal(JSON.stringify(cj), frozen)
  const on = toggled(off, '/p', 'a', false)
  assert.deepEqual(on.projects['/p'].disabledMcpServers, ['b'])
})

test('toggledSettings approves and rejects .mcp.json servers, keeping other keys', () => {
  const s = { permissions: { allow: ['x'] }, disabledMcpjsonServers: ['docs'] }
  const approved = toggledSettings(s, 'docs', false)
  assert.deepEqual(approved.enabledMcpjsonServers, ['docs'])
  assert.deepEqual(approved.disabledMcpjsonServers, [])
  assert.deepEqual(approved.permissions, { allow: ['x'] })
  const rejected = toggledSettings(approved, 'docs', true)
  assert.deepEqual(rejected.disabledMcpjsonServers, ['docs'])
  assert.deepEqual(rejected.enabledMcpjsonServers, [])
  assert.deepEqual(s.disabledMcpjsonServers, ['docs']) // input untouched
  assert.deepEqual(toggledSettings(undefined, 'a', true).disabledMcpjsonServers, ['a'])
})

test('addJsonArgs is argv, never a shell string', () => {
  assert.deepEqual(addJsonArgs('s', 'user', { type: 'http', url: 'https://x' }), ['mcp', 'add-json', 's', '{"type":"http","url":"https://x"}', '-s', 'user'])
})
