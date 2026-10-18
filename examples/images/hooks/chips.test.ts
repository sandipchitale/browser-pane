import { test, expect } from 'claude-code/testing'

// browser-pane, inline (the test kit loads no dependencies). Its show reports what it was asked
// through a fetch the test records, and opens a window unless the select is 'no-window'.
const browserPane = {
  name: 'browser-pane',
  register(on: any) {
    on('engine.create', async (_$: any, e: any, next: any) => ({
      ...(await next(e)),
      browserPane: {
        register: async () => ({ isRegistered: true }),
        show: async () => ({ isOpened: false, reason: 'not answered' }),
        update: async () => ({ isSent: true }),
      },
    }))
    on('browserPane.show', async ($: any, e: any) => {
      await $.http.fetch('http://record/show', { method: 'POST', body: JSON.stringify(e) })
      return { value: e.data?.origins?.['9'] ? { isOpened: false, reason: 'no $.process here' } : { isOpened: true, how: 'opened' } }
    })
  },
}

// The editor beneath the plugins: applies a typed edit to the draft.
const typing = {
  name: 'typing',
  register(on: any) {
    on('prompt.edit', (_$: any, e: any) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  },
}

const edit = ($: any, text: string, inputText: string) =>
  $.prompt.edit({ origin: 'typed', text, cursor: text.length, start: text.length, end: text.length, inputText })

function world(on: any) {
  const shows: any[] = []
  const runs: string[][] = []
  const toasts: string[] = []
  on('session.id', () => ({ value: 'sid' }))
  on('http.fetch', (_$: any, e: any) => (shows.push(JSON.parse(e.init.body)), { value: { status: 200, ok: true, headers: {}, text: '' } }))
  on('process.run', (_$: any, e: any) => (runs.push([...e.argv]), { value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', (_$: any, e: any) => (toasts.push(e.text ?? String(e)), { value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => (globalThis as any).h($.ui.resolve(e).Box, {}))
  return { shows, runs, toasts }
}

test('a chip shows its image in the Images tab', { plugins: [browserPane, typing] } as any, async ($: any, on: any) => {
  const { shows, runs } = world(on)
  await edit($, '[Image #2]', ' ')
  const ui = await $.ui.mount({ plugin: 'browser-pane-images', surface: 'terminal', component: 'AbovePrompt', props: {} })
  await ui.press({ key: 'img-2' })
  expect(shows).toEqual([{ tab: 'images', select: '2', data: { session: 'sid', origins: {} } }])
  expect(runs).toEqual([])
})

test("when the window can't open, a chip opens the dropped file in the OS viewer", { plugins: [browserPane, typing] } as any, async ($: any, on: any) => {
  const { shows, runs } = world(on)
  // A dropped file, then the [Image #9] tag Claude Code puts in its place.
  await edit($, '', '/Users/me/shot.png')
  await edit($, '', '[Image #9]')
  await edit($, '[Image #9]', ' ')
  const ui = await $.ui.mount({ plugin: 'browser-pane-images', surface: 'terminal', component: 'AbovePrompt', props: {} })
  await ui.press({ key: 'img-9' })
  expect(shows[0].data.origins).toEqual({ 9: '/Users/me/shot.png' })
  expect(runs[0]).toEqual(['open', '/Users/me/shot.png'])
})
