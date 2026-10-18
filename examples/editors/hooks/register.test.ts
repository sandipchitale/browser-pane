import { test, expect } from 'claude-code/testing'

// browser-pane, inline (the test kit loads no dependencies): each call is reported through a fetch
// the test records, and show opens a window.
const browserPane = {
  name: 'browser-pane',
  register(on: any) {
    on('engine.create', async (_$: any, e: any, next: any) => ({
      ...(await next(e)),
      browserPane: {
        register: async () => ({ isRegistered: false }),
        show: async () => ({ isOpened: false }),
        update: async () => ({ isSent: false }),
      },
    }))
    on('browserPane.register', async ($: any, e: any) => {
      await $.http.fetch('http://record/register', { method: 'POST', body: JSON.stringify(e) })
      return { value: { isRegistered: true } }
    })
    on('browserPane.show', async ($: any, e: any) => {
      await $.http.fetch('http://record/show', { method: 'POST', body: JSON.stringify(e) })
      return { value: { isOpened: true, how: 'opened' } }
    })
    on('browserPane.update', async ($: any, e: any) => {
      await $.http.fetch('http://record/update', { method: 'POST', body: JSON.stringify(e) })
      return { value: { isSent: true } }
    })
  },
}

function world(on: any) {
  const calls: { method: string; args: any }[] = []
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: '6f1c0b1e-0000-4000-8000-000000000001' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('http.fetch', (_$: any, e: any) => {
    calls.push({ method: new URL(e.url).pathname.slice(1), args: JSON.parse(e.init.body) })
    return { value: { status: 200, ok: true, headers: {}, text: '' } }
  })
  return calls
}

const start = ($: any) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

test('three tabs share one server module, and each is told the session', { plugins: [browserPane] } as any, async ($: any, on: any) => {
  const calls = world(on)
  await start($)
  const registers = calls.filter(c => c.method === 'register').map(c => c.args)
  expect(registers.map(r => r.id)).toEqual(['plugins', 'mcp', 'cockpit'])
  expect(new Set(registers.map(r => r.server)).size).toBe(1)
  expect(registers[1].root.endsWith('/tabs/mcp')).toBe(true)
  const updates = calls.filter(c => c.method === 'update').map(c => c.args)
  expect(updates.map(u => u.tab)).toEqual(['plugins', 'mcp', 'cockpit'])
  expect(updates[0].data).toEqual({ session: '6f1c0b1e-0000-4000-8000-000000000001', cwd: '/work' })
})

test('what the session measures reaches the Cockpit tab', { plugins: [browserPane] } as any, async ($: any, on: any) => {
  const calls = world(on)
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
  await start($)
  calls.length = 0
  const measured = { context: { tokens: 84_100, window: 200_000, percent: 42 }, rateLimits: [{ kind: 'seven_day', percentUsed: 61 }], cost: { usd: 2.5 } }
  await $.session.measure({ ...measured, changed: ['context'] })
  // The update is fire and forget; let it land.
  for (let i = 0; i < 20 && !calls.some(c => c.method === 'update'); i++) await new Promise(r => setTimeout(r, 5))
  const update = calls.find(c => c.method === 'update')
  expect(update?.args.tab).toBe('cockpit')
  expect(update?.args.data.usage).toEqual(measured)
})

test('/editors opens the tab it names, the Plugins tab by default', { plugins: [browserPane] } as any, async ($: any, on: any) => {
  const calls = world(on)
  await start($)
  calls.length = 0
  expect((await $.command.run({ command: 'editors', args: 'mcp' })).text).toBe('editors: MCP tab opened.')
  await $.command.run({ command: 'editors', args: '' })
  expect(calls.filter(c => c.method === 'show').map(c => c.args.tab)).toEqual(['mcp', 'plugins'])
  expect((await $.command.run({ command: 'editors', args: 'nope' })).text).toContain('no "nope" tab')
})
