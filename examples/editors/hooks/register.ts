import type { Register } from 'claude-code'

// Three tabs, one server module: each tab answers its own routes.
const TABS = {
  plugins: { title: 'Plugins', description: 'Plugins and marketplaces: install, enable, disable, update; add, update and remove marketplaces.' },
  mcp: { title: 'MCP', description: 'MCP servers by scope with live health: add, edit, remove, enable and disable.' },
  cockpit: { title: 'Cockpit', description: 'This session, live: tokens and cost, subagents, and transcript search.' },
} as const
type TabId = keyof typeof TABS
const isTab = (s: string): s is TabId => s in TABS

// Live feed for the Cockpit: the saved transcript can lag the running session, so the hooks below
// report prompts, tool calls and turn usage as they happen. Each event carries a key that is new for
// every event, since browser-pane resends a tab's latest data when its server restarts.
const BOOT = Math.random().toString(36).slice(2)
let seq = 0
let where: { session: string; cwd: string } | undefined
// What the session last measured (context fill, rate-limit windows, cost), for the Cockpit's meters.
// It rides with every Cockpit update, since browser-pane keeps only a tab's latest data.
let usage: unknown = null

async function context($: any) {
  where ??= { session: await $.session.id(), cwd: await $.session.cwd() }
  return where
}

// Fire and forget: a failure here never touches the session.
function emit($: any, event: Record<string, unknown>) {
  void (async () => {
    try {
      const data = { ...(await context($)), usage, key: `${BOOT}-${++seq}`, event: { at: Date.now(), ...event } }
      await $.browserPane.update({ tab: 'cockpit', data })
    } catch {}
  })()
}

// Fire and forget, like emit.
function measured($: any, snapshot: unknown) {
  usage = snapshot
  void (async () => {
    try {
      await $.browserPane.update({ tab: 'cockpit', data: { ...(await context($)), usage } })
    } catch {}
  })()
}

function summary(input: Record<string, unknown>) {
  const pick = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt']
  const hit = pick.map(k => input[k]).find(v => typeof v === 'string') ?? Object.values(input).find(v => typeof v === 'string')
  return String(hit ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const data = await context($)
    for (const [id, tab] of Object.entries(TABS)) {
      await $.browserPane.register({ id, ...tab, root: `${$.plugin.root}/tabs/${id}`, server: `${$.plugin.root}/tab-server/server.mjs` })
      await $.browserPane.update({ tab: id, data })
    }
    await $.command.register({
      name: 'editors',
      description: 'Open an editor tab in the browser-pane window: /editors [plugins | mcp | cockpit]',
    })
    const result = await next(e)
    try {
      const { context: fill, rateLimits, cost } = await $.session.usage()
      measured($, { context: fill, rateLimits, cost })
    } catch {
      // No figures yet; session.measure fills them in after the first turn.
    }
    return result
  })

  on('session.measure', ($, e, next) => {
    measured($, { context: e.context, rateLimits: e.rateLimits, cost: e.cost })
    return next(e)
  })

  on('command.run', { command: 'editors' }, async ($, e) => {
    const arg = e.args.trim() || 'plugins'
    if (!isTab(arg)) return { text: `editors: no "${arg}" tab. Use /editors plugins, /editors mcp or /editors cockpit.` }
    const r = await $.browserPane.show({ tab: arg, data: { ...(await context($)), usage } })
    if (r.isOpened) return { text: `editors: ${TABS[arg].title} tab ${r.how === 'reused' ? 'shown in the open window' : 'opened'}.` }
    return { text: `editors: the browser window can't open (${r.reason}).` }
  })

  on('prompt.submit', ($, e, next) => {
    emit($, { kind: 'prompt', text: e.text })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const { tool, tool_use_id: id, agentId, ...args } = e as Record<string, unknown> & { tool: string; tool_use_id?: string; agentId?: string }
    if (id) emit($, { kind: 'tool-start', id, tool, agentId, summary: summary(args) })
    const ran = await next(e)
    if (id) {
      const denied = 'deny' in ran && ran.deny !== undefined
      emit($, { kind: 'tool-end', id, agentId, isError: denied || ('isError' in ran && ran.isError === true), text: denied ? String((ran as { deny: string }).deny) : String(('text' in ran && ran.text) || '') })
    }
    return ran
  })

  on('turn.complete', ($, e, next) => {
    emit($, { kind: 'turn', turnId: e.turnId, agentId: e.agentId, answer: e.answer, usage: e.usage, model: e.usage?.model })
    return next(e)
  })
}
