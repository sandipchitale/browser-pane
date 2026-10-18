// Pure logic for the session cockpit: turns Claude Code transcript lines (JSONL) into a live model.
// No I/O here; the server feeds it lines as the file grows.

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TEXT_CAP = 4000

export function createState() {
  return {
    lines: 0,
    title: '',
    cwd: '',
    model: '',
    started: undefined,
    last: undefined,
    turns: [], // { n, ts }
    tools: new Map(), // id -> { id, name, summary, ts, end, ok, turn, agent }
    usage: new Map(), // message id -> { ts, model, input, output, cacheRead, cacheCreate, turn }
    cost: undefined, // last cost-state record
    messages: [], // searchable { role, ts, text, turn }
    agents: new Map(), // tool id of an Agent call -> { id, label, type, ts, end, ok }
  }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => (b?.type === 'text' ? b.text : b?.type === 'tool_result' ? textOf(b.content) : ''))
    .filter(Boolean)
    .join('\n')
}

export function summarizeInput(name, input = {}) {
  const pick = k => (typeof input[k] === 'string' ? input[k] : undefined)
  const s =
    pick('command') ?? pick('file_path') ?? pick('path') ?? pick('pattern') ?? pick('query') ?? pick('url') ??
    pick('description') ?? pick('prompt') ?? Object.values(input).find(v => typeof v === 'string') ?? ''
  return s.replace(/\s+/g, ' ').trim().slice(0, 160)
}

const isAgentTool = name => name === 'Agent' || name === 'Task'

export function feed(state, rawLines) {
  for (const raw of rawLines) {
    if (!raw) continue
    let r
    try { r = JSON.parse(raw) } catch { continue }
    state.lines++
    if (r.timestamp) {
      state.started ??= r.timestamp
      state.last = r.timestamp
    }
    if (r.cwd) state.cwd = r.cwd
    const turn = state.turns.length - 1
    switch (r.type) {
      case 'ai-title':
        state.title = r.aiTitle ?? state.title
        break
      case 'cost-state':
        state.cost = r
        break
      case 'user': {
        const content = r.message?.content
        const results = Array.isArray(content) ? content.filter(b => b?.type === 'tool_result') : []
        for (const b of results) {
          const t = state.tools.get(b.tool_use_id)
          if (t) {
            t.end = r.timestamp
            t.ok = !b.is_error
            t.result = textOf(b.content).replace(/\s+/g, ' ').trim().slice(0, 300)
            const a = state.agents.get(t.id)
            if (a) { a.end = r.timestamp; a.ok = t.ok }
          }
        }
        if (results.length) break
        const text = textOf(content).trim()
        if (!text || r.isMeta || r.isSidechain) break
        state.turns.push({ n: state.turns.length + 1, ts: r.timestamp })
        state.messages.push({ role: 'user', ts: r.timestamp, text: text.slice(0, TEXT_CAP), turn: state.turns.length - 1 })
        break
      }
      case 'assistant': {
        const m = r.message ?? {}
        if (m.model && !String(m.model).startsWith('<')) state.model = m.model
        if (m.usage) {
          state.usage.set(m.id ?? r.uuid, {
            ts: r.timestamp,
            model: m.model,
            input: m.usage.input_tokens ?? 0,
            output: m.usage.output_tokens ?? 0,
            cacheRead: m.usage.cache_read_input_tokens ?? 0,
            cacheCreate: m.usage.cache_creation_input_tokens ?? 0,
            turn,
          })
        }
        for (const b of Array.isArray(m.content) ? m.content : []) {
          if (b.type === 'tool_use' && !state.tools.has(b.id)) {
            const tool = {
              id: b.id, name: b.name, summary: summarizeInput(b.name, b.input), ts: r.timestamp, turn,
              agent: r.isSidechain ? (r.agentId ?? r.parentToolUseID ?? 'sidechain') : undefined,
            }
            state.tools.set(b.id, tool)
            if (isAgentTool(b.name)) {
              state.agents.set(b.id, {
                id: b.id, label: b.input?.description ?? b.name, type: b.input?.subagent_type ?? 'agent',
                ts: r.timestamp,
              })
            }
          } else if (b.type === 'text' && b.text?.trim()) {
            state.messages.push({ role: 'assistant', ts: r.timestamp, text: b.text.slice(0, TEXT_CAP), turn })
          }
        }
        break
      }
    }
  }
}

const ms = (a, b) => (a && b ? Math.max(0, Date.parse(b) - Date.parse(a)) : undefined)

export function snapshot(state) {
  const usage = [...state.usage.values()]
  const tokens = usage.reduce(
    (t, u) => ({
      input: t.input + u.input, output: t.output + u.output,
      cacheRead: t.cacheRead + u.cacheRead, cacheCreate: t.cacheCreate + u.cacheCreate,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
  )
  const lastUsage = usage.at(-1)
  const perTurn = state.turns.map((t, i) => {
    const us = usage.filter(u => u.turn === i)
    const lastU = us.at(-1)
    const sum = k => us.reduce((s, u) => s + u[k], 0)
    return {
      n: t.n, ts: t.ts,
      calls: us.length,
      output: sum('output'), input: sum('input'), cacheRead: sum('cacheRead'), cacheCreate: sum('cacheCreate'),
      context: lastU ? lastU.input + lastU.cacheRead + lastU.cacheCreate : 0,
    }
  })
  const tools = [...state.tools.values()]
  const byTool = {}
  for (const t of tools) {
    const e = (byTool[t.name] ??= { name: t.name, count: 0, errors: 0, ms: 0 })
    e.count++
    if (t.ok === false) e.errors++
    e.ms += ms(t.ts, t.end) ?? 0
  }
  const c = state.cost
  return {
    title: state.title, cwd: state.cwd, model: state.model, started: state.started, last: state.last,
    lines: state.lines,
    cost: c && {
      usd: c.totalCostUSD, apiMs: c.totalAPIDuration, toolMs: c.totalToolDuration,
      added: c.totalLinesAdded, removed: c.totalLinesRemoved, wallMs: c.totalDuration,
      models: c.modelUsage ?? {}, unknown: !!c.hasUnknownModelCost,
    },
    tokens,
    context: lastUsage ? lastUsage.input + lastUsage.cacheRead + lastUsage.cacheCreate : 0,
    perTurn,
    byTool: Object.values(byTool).sort((a, b) => b.count - a.count),
    turns: state.turns.map(t => ({ n: t.n, ts: t.ts })),
    // Each call's output stays here for search; the page needs only the rest.
    tools: tools.map(({ result, ...t }) => ({ ...t, ms: ms(t.ts, t.end), running: t.end === undefined })),
    agents: [...state.agents.values()].map(a => ({ ...a, ms: ms(a.ts, a.end), running: a.end === undefined })),
  }
}

export function search(state, query, limit = 50) {
  const q = String(query).toLowerCase().trim()
  if (!q) return []
  const out = []
  for (const m of state.messages) {
    const i = m.text.toLowerCase().indexOf(q)
    if (i < 0) continue
    const from = Math.max(0, i - 60)
    out.push({ role: m.role, ts: m.ts, turn: m.turn, snippet: m.text.slice(from, i + q.length + 140).replace(/\s+/g, ' '), at: i - from })
  }
  for (const t of state.tools.values()) {
    const hay = `${t.name} ${t.summary} ${t.result ?? ''}`
    const i = hay.toLowerCase().indexOf(q)
    if (i >= 0) out.push({ role: 'tool', ts: t.ts, turn: t.turn, snippet: hay.slice(Math.max(0, i - 40), i + q.length + 140), at: Math.min(i, 40), tool: t.name })
  }
  return out.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? '')).slice(0, limit)
}

// ---- live feed: hook events from the mod, turned into transcript-shaped records ----
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')

// Returns a record for `feed`, or undefined for an event that is malformed.
export function fromEvent(ev) {
  if (!ev || typeof ev !== 'object') return undefined
  const timestamp = new Date(Number.isFinite(ev.at) ? ev.at : Date.now()).toISOString()
  const agent = ev.agentId ? { isSidechain: true, agentId: str(ev.agentId, 80) } : {}
  switch (ev.kind) {
    case 'prompt':
      return { type: 'user', timestamp, message: { role: 'user', content: str(ev.text, TEXT_CAP) } }
    case 'tool-start':
      return {
        type: 'assistant', timestamp, ...agent,
        message: { id: 'live-' + str(ev.id, 80), content: [{ type: 'tool_use', id: str(ev.id, 80), name: str(ev.tool, 120), input: { description: str(ev.summary, 160) } }] },
      }
    case 'tool-end':
      return { type: 'user', timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: str(ev.id, 80), is_error: !!ev.isError, content: str(ev.text, 300) }] } }
    case 'turn': {
      const u = ev.usage ?? {}
      return {
        type: 'assistant', timestamp, ...agent,
        message: {
          id: 'live-turn-' + str(ev.turnId, 80), model: str(ev.model, 80),
          content: ev.answer ? [{ type: 'text', text: str(ev.answer, TEXT_CAP) }] : [],
          usage: { input_tokens: +u.input_tokens || 0, output_tokens: +u.output_tokens || 0, cache_read_input_tokens: +u.cache_read_input_tokens || 0, cache_creation_input_tokens: +u.cache_creation_input_tokens || 0 },
        },
      }
    }
  }
  return undefined
}

// The file is authoritative; the live overlay fills only what it has not recorded yet (newer than its last record).
export function merge(file, live) {
  const cutoff = file.last ? Date.parse(file.last) : 0
  const newer = ts => !ts || Date.parse(ts) > cutoff
  const keepTurns = live.turns.filter(t => newer(t.ts))
  const keepN = new Set(keepTurns.map(t => t.n))
  const base = file.turns.length
  const renum = new Map(keepTurns.map((t, i) => [t.n, base + i + 1]))
  const turns = [...file.turns, ...keepTurns.map(t => ({ ...t, n: renum.get(t.n) }))]
  const tools = [...file.tools, ...live.tools.filter(t => newer(t.ts)).map(t => ({ ...t, turn: t.turn >= 0 && renum.has(t.turn + 1) ? renum.get(t.turn + 1) - 1 : base }))]
  const perTurn = [...file.perTurn, ...live.perTurn.filter(p => keepN.has(p.n)).map(p => ({ ...p, n: renum.get(p.n) }))]
  const add = k => live.perTurn.filter(p => keepN.has(p.n)).reduce((s, p) => s + p[k], 0)
  const tokens = {
    input: file.tokens.input + add('input'), output: file.tokens.output + add('output'),
    cacheRead: file.tokens.cacheRead + add('cacheRead'), cacheCreate: file.tokens.cacheCreate + add('cacheCreate'),
  }
  const byTool = {}
  for (const t of tools) {
    const e = (byTool[t.name] ??= { name: t.name, count: 0, errors: 0, ms: 0 })
    e.count++
    if (t.ok === false) e.errors++
    e.ms += t.ms ?? 0
  }
  const lastLive = perTurn.at(-1)
  return {
    ...file,
    title: file.title || live.title, cwd: file.cwd || live.cwd, model: live.model || file.model,
    last: [file.last, live.last].filter(Boolean).sort().at(-1),
    started: file.started ?? live.started,
    tokens, turns, tools, perTurn,
    context: lastLive?.context || file.context,
    byTool: Object.values(byTool).sort((a, b) => b.count - a.count),
    agents: [...file.agents, ...live.agents.filter(a => newer(a.ts))],
    liveTurns: keepTurns.length, // how much of what is shown came from the live feed, not the saved transcript
  }
}
