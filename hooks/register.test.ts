import { test, expect, mock } from 'claude-code/testing'

// A consumer, inline: registers a tab at session start, and shows it from /demo <tab> <select>.
const consumer = {
  name: 'consumer',
  register(on: any) {
    on('session.start', async ($: any, e: any, next: any) => {
      const r = await $.browserPane.register({ id: 'demo', title: 'Demo', root: '/tmp/demo-tab' })
      await $.command.register({ name: 'demo', description: JSON.stringify(r) })
      return next(e)
    })
    on('command.run', { command: 'demo' }, async ($: any, e: any) => {
      const [tab, select] = e.args.split(' ')
      return { text: JSON.stringify(await $.browserPane.show({ tab: tab || undefined, select, data: { n: 1 } })) }
    })
    on('command.run', { command: 'bad' }, async ($: any) => {
      return { text: JSON.stringify(await $.browserPane.register({ id: 'Bad Id', title: 'x', root: '/tmp' })) }
    })
  },
}

// The engine beneath: a session, commands, and a server that says hello and answers what it's sent.
function world(on: any, { canSpawn = true, polled = false } = {}) {
  const posts: { path: string; body: any }[] = []
  let release: () => void = () => {}
  const exited = new Promise<void>(resolve => (release = resolve))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  on('process.spawn', async function* () {
    if (!canSpawn) throw new Error('no process here')
    yield { stream: 'stdout', text: '{"port":4321,"token":"tok"}\n' }
    await exited
    return { code: 0, signal: null }
  })
  on('http.fetch', (_$: any, e: any) => {
    const path = new URL(e.url).pathname
    const body = JSON.parse(e.init?.body ?? '{}')
    posts.push({ path, body })
    const answer = path === '/control/show' ? { isOpened: true, how: polled ? 'reused' : 'opened' } : { ok: true }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answer) } }
  })
  return { posts, release }
}

const start = ($: any) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

async function run($: any, clock: any, command: string, args = '') {
  const pending = $.command.run({ command, args })
  await clock.advance(0)
  await clock.advance(0)
  return JSON.parse((await pending).text)
}

test('show starts the server, tells it the tabs, and opens the window', { plugins: [consumer] } as any, async ($: any, on: any) => {
  const clock = mock.clock(on)
  const { posts, release } = world(on)
  await start($)
  const r = await run($, clock, 'demo', 'demo item-3')
  expect(r).toEqual({ isOpened: true, how: 'opened' })
  expect(posts.map(p => p.path)).toEqual(['/control/register', '/control/data', '/control/show'])
  expect(posts[0]?.body).toEqual({ id: 'demo', title: 'Demo', root: '/tmp/demo-tab' })
  expect(posts[2]?.body).toEqual({ tab: 'demo', select: 'item-3' })
  release()
})

test('a second show reuses the running server', { plugins: [consumer] } as any, async ($: any, on: any) => {
  const clock = mock.clock(on)
  const { posts, release } = world(on)
  await start($)
  await run($, clock, 'demo', 'demo a')
  posts.length = 0
  const r = await run($, clock, 'demo', 'demo b')
  expect(r.isOpened).toBe(true)
  expect(posts.map(p => p.path)).toEqual(['/control/data', '/control/show'])
  release()
})

test('with no $.process (desktop app, IDE), show says why and the caller can fall back', { plugins: [consumer] } as any, async ($: any, on: any) => {
  const clock = mock.clock(on)
  world(on, { canSpawn: false })
  await start($)
  const r = await run($, clock, 'demo', 'demo x')
  expect(r.isOpened).toBe(false)
  expect(r.reason).toContain("can't run here")
})

test('an unknown tab is refused without starting anything', { plugins: [consumer] } as any, async ($: any, on: any) => {
  const clock = mock.clock(on)
  const { posts } = world(on)
  await start($)
  const r = await run($, clock, 'demo', 'nope')
  expect(r).toEqual({ isOpened: false, reason: 'no tab "nope"' })
  expect(posts).toEqual([])
})

test('a bad tab id is refused at register', { plugins: [consumer] } as any, async ($: any, on: any) => {
  const clock = mock.clock(on)
  world(on)
  await start($)
  const r = await run($, clock, 'bad')
  expect(r.isRegistered).toBe(false)
  expect(r.reason).toContain('lowercase')
})
