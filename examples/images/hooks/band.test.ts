import { test, expect } from 'claude-code/testing'
import { register } from './register'

// A prompt.edit as the engine raises it: the draft before, what is typed, and where.
const edit = ($: any, text: string, inputText: string) =>
  $.prompt.edit({ origin: 'typed', text, cursor: text.length, start: text.length, end: text.length, inputText })

const mountBand = ($: any) =>
  $.ui.mount({ plugin: 'browser-pane-images', surface: 'terminal', component: 'AbovePrompt', props: {} })

const typing = {
  name: 'typing',
  register(on: any) {
    on('prompt.edit', (_$: any, e: any) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  },
}

test('chip appears after typing a space after the tag', { plugins: [typing] } as any, async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => (globalThis as any).h($.ui.resolve(e).Box, {}))
  register(on, {} as any)
  await edit($, '[Image #1]', ' ')
  const ui = await mountBand($)
  expect(await ui.find({ text: 'Image #1' })).toBeTruthy()
})

test('no chip, and no error, with an empty draft', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => (globalThis as any).h($.ui.resolve(e).Box, {}))
  register(on, {} as any)
  const ui = await mountBand($)
  expect(await ui.find({ text: 'Image #' })).toBeUndefined()
})
