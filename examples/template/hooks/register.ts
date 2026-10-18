import type { Register } from 'claude-code'

// The names a copy changes first (see integration.md, "Make it yours"): the tab's id and title here,
// and the command, written as a literal where it is registered and matched (claude plugin validate
// reads those literals to know the hook answers its own command). The tab id must be unique across
// mods, so use your mod's name.
const TAB = 'template'
const TITLE = 'Template'

export const register: Register = on => {
  // Register the tab once per session. Cheap: browser-pane starts nothing until the first show.
  on('session.start', async ($, e, next) => {
    await $.browserPane.register({
      id: TAB,
      title: TITLE,
      root: `${$.plugin.root}/tab`,
      server: `${$.plugin.root}/tab-server/server.mjs`,
      description: 'A starter tab: /template [text] shows the text here.',
      pinned: true, // first in the Guide and the tab strip, until the person unpins it
    })
    // Data the tab's server module needs even when the tab is opened from the Guide, not by a show.
    await $.browserPane.update({ tab: TAB, data: { session: await $.session.id() } })
    await $.command.register({ name: 'template', description: `Show text in the ${TITLE} tab: /template [text]` })
    return next(e)
  })

  on('command.run', { command: 'template' }, async ($, e) => {
    const text = e.args.trim() || 'Hello from Claude Code'
    const r = await $.browserPane.show({
      tab: TAB,
      select: text, // reaches the page: browserPane.onSelect
      data: { session: await $.session.id(), shownAt: new Date().toISOString() }, // reaches the server module: update
    })
    if (r.isOpened) return { text: `template: "${text}" is in the ${TITLE} tab (${r.how}).` }
    // No window here (the desktop app or an IDE has no $.process, or Node is missing): say so, or show
    // the content another way, say in a Pane.
    return { text: `template: no browser window (${r.reason}). You said: ${text}` }
  })
}
