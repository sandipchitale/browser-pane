import { test, expect } from 'claude-code/testing'

// browser-pane, inline: the test kit loads no dependencies, so a test brings its own. Each call is
// reported through a fetch the test records; show opens a window unless the text is 'no window'.
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
    on('browserPane.update', async ($: any, e: any) => {
      await $.http.fetch('http://record/update', { method: 'POST', body: JSON.stringify(e) })
      return { value: { isSent: true } }
    })
    on('browserPane.show', async ($: any, e: any) => {
      await $.http.fetch('http://record/show', { method: 'POST', body: JSON.stringify(e) })
      return { value: e.select === 'no window' ? { isOpened: false, reason: 'no $.process here' } : { isOpened: true, how: 'opened' } }
    })
  },
}

const SESSION = '6f1c0b1e-0000-4000-8000-000000000002'

// The engine beneath the plugins: a session, commands, and the fetches recorded.
function world(on: any) {
  const calls: { method: string; args: any }[] = []
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('http.fetch', (_$: any, e: any) => {
    calls.push({ method: new URL(e.url).pathname.slice(1), args: JSON.parse(e.init.body) })
    return { value: { status: 200, ok: true, headers: {}, text: '' } }
  })
  return calls
}

const start = ($: any) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

test('registers its tab at session start and tells it the session', { plugins: [browserPane] } as any, async ($: any, on: any) => {
  const calls = world(on)
  await start($)
  const register = calls.find(c => c.method === 'register')?.args
  expect(register.id).toBe('template')
  expect(register.root.endsWith('/tab')).toBe(true)
  expect(register.server.endsWith('/tab-server/server.mjs')).toBe(true)
  expect(register.pinned).toBe(true)
  expect(calls.find(c => c.method === 'update')?.args).toEqual({ tab: 'template', data: { session: SESSION } })
})

test('/template shows the text in the tab', { plugins: [browserPane] } as any, async ($: any, on: any) => {
  const calls = world(on)
  await start($)
  const r = await $.command.run({ command: 'template', args: 'hi there' })
  expect(r.text).toBe('template: "hi there" is in the Template tab (opened).')
  const show = calls.find(c => c.method === 'show')?.args
  expect(show.tab).toBe('template')
  expect(show.select).toBe('hi there')
  expect(show.data.session).toBe(SESSION)
})

test('/template says why when no window can open', { plugins: [browserPane] } as any, async ($: any, on: any) => {
  world(on)
  await start($)
  const r = await $.command.run({ command: 'template', args: 'no window' })
  expect(r.text).toBe('template: no browser window (no $.process here). You said: no window')
})
