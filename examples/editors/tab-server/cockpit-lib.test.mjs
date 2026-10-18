import test from 'node:test'
import assert from 'node:assert/strict'
import { createState, feed, snapshot, search, summarizeInput, fromEvent, merge, SESSION_ID } from './cockpit-lib.mjs'

const j = o => JSON.stringify(o)
const user = (text, ts) => j({ type: 'user', timestamp: ts, cwd: '/w', message: { role: 'user', content: text } })
const asst = (id, content, ts, usage = { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }, extra = {}) =>
  j({ type: 'assistant', timestamp: ts, message: { id, model: 'claude-x', content, usage }, ...extra })
const result = (id, text, ts, isError = false) =>
  j({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } })

test('pairs tool calls with results and measures duration', () => {
  const s = createState()
  feed(s, [
    user('fix the bug', '2026-01-01T00:00:00.000Z'),
    asst('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm   test' } }], '2026-01-01T00:00:01.000Z'),
    result('t1', 'ok', '2026-01-01T00:00:04.000Z'),
    asst('m2', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a/b.ts' } }], '2026-01-01T00:00:05.000Z'),
  ])
  const snap = snapshot(s)
  assert.equal(snap.turns.length, 1)
  const [t1, t2] = snap.tools
  assert.deepEqual(snap.tools.map(t => [t.id, t.turn]), [['t1', 0], ['t2', 0]])
  assert.equal(t1.summary, 'npm test')
  assert.equal(t1.ms, 3000)
  assert.equal(t1.ok, true)
  assert.equal(t2.running, true)
})

test('counts a streamed message once and sums tokens', () => {
  const s = createState()
  const usage = { input_tokens: 1, output_tokens: 7, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 }
  feed(s, [
    user('hi', '2026-01-01T00:00:00Z'),
    asst('m1', [{ type: 'thinking' }], '2026-01-01T00:00:01Z', { ...usage, output_tokens: 2 }),
    asst('m1', [{ type: 'text', text: 'hello' }], '2026-01-01T00:00:02Z', usage),
  ])
  const snap = snapshot(s)
  assert.equal(snap.tokens.output, 7)
  assert.equal(snap.context, 51)
  assert.equal(snap.perTurn[0].calls, 1)
})

test('uses the last cost-state and flags errors per tool', () => {
  const s = createState()
  feed(s, [
    user('x', '2026-01-01T00:00:00Z'),
    asst('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'false' } }], '2026-01-01T00:00:01Z'),
    result('t1', 'boom', '2026-01-01T00:00:02Z', true),
    j({ type: 'cost-state', totalCostUSD: 1.5, modelUsage: {} }),
    j({ type: 'cost-state', totalCostUSD: 2.5, modelUsage: {} }),
  ])
  const snap = snapshot(s)
  assert.equal(snap.cost.usd, 2.5)
  assert.equal(snap.byTool[0].errors, 1)
})

test('tracks Agent calls and ignores tool results as prompts and bad lines', () => {
  const s = createState()
  feed(s, [
    'not json',
    user('go', '2026-01-01T00:00:00Z'),
    asst('m1', [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'explore', subagent_type: 'Explore' } }], '2026-01-01T00:00:01Z'),
    result('a1', 'done', '2026-01-01T00:00:11Z'),
  ])
  const snap = snapshot(s)
  assert.equal(snap.turns.length, 1)
  assert.deepEqual([snap.agents[0].label, snap.agents[0].type, snap.agents[0].ms], ['explore', 'Explore', 10000])
})

test('search finds prompts, replies and tool output, newest first', () => {
  const s = createState()
  feed(s, [
    user('please rename Widget', '2026-01-01T00:00:00Z'),
    asst('m1', [{ type: 'text', text: 'renamed the widget everywhere' }, { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'Widget' } }], '2026-01-01T00:00:02Z'),
  ])
  const hits = search(s, 'WIDGET')
  assert.equal(hits.length, 3)
  assert.equal(hits[0].ts, '2026-01-01T00:00:02Z')
  assert.deepEqual(search(s, ''), [])
})

test('summarizeInput and session id validation', () => {
  assert.equal(summarizeInput('Grep', { pattern: 'a  b' }), 'a b')
  assert.equal(summarizeInput('X', {}), '')
  assert.ok(SESSION_ID.test('2a3a67be-2b7c-4f30-868c-259428bb3121'))
  assert.ok(!SESSION_ID.test('../../etc/passwd'))
})

test('live events become records and overlay only what the file lacks', () => {
  const file = createState()
  feed(file, [user('old', '2026-01-01T00:00:00Z'), asst('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], '2026-01-01T00:00:01Z'), result('t1', 'ok', '2026-01-01T00:00:02Z')])
  const live = createState()
  const at = s => Date.parse(s)
  feed(live, [
    // already in the file: must not be counted twice
    fromEvent({ kind: 'prompt', at: at('2026-01-01T00:00:00Z'), text: 'old' }),
    fromEvent({ kind: 'turn', at: at('2026-01-01T00:00:01Z'), turnId: 'x0', usage: { output_tokens: 99 } }),
    // new
    fromEvent({ kind: 'prompt', at: at('2026-01-01T00:01:00Z'), text: 'new prompt' }),
    fromEvent({ kind: 'tool-start', at: at('2026-01-01T00:01:01Z'), id: 't9', tool: 'Read', summary: '/a.ts' }),
    fromEvent({ kind: 'tool-end', at: at('2026-01-01T00:01:03Z'), id: 't9', isError: true, text: 'nope' }),
    fromEvent({ kind: 'turn', at: at('2026-01-01T00:01:04Z'), turnId: 'x1', model: 'm', answer: 'done', usage: { input_tokens: 1, output_tokens: 7, cache_read_input_tokens: 30 } }),
    fromEvent({ kind: 'bogus' }),
  ].filter(Boolean).map(JSON.stringify))
  const m = merge(snapshot(file), snapshot(live))
  assert.equal(m.turns.length, 2)
  assert.equal(m.turns[1].ts, '2026-01-01T00:01:00.000Z')
  assert.equal(m.turns[1].n, 2)
  assert.deepEqual(m.tools.map(t => [t.id, t.ok, t.ms]), [['t1', true, 1000], ['t9', false, 2000]])
  assert.equal(m.tokens.output, 10 + 7)
  assert.equal(m.liveTurns, 1)
  assert.equal(m.byTool.find(x => x.name === 'Read').errors, 1)
})
