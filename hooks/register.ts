import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type {
  BrowserPaneJson,
  BrowserPaneRegisterResult,
  BrowserPaneShowResult,
  BrowserPaneTab,
  BrowserPaneUpdateResult,
} from '../types'
import { ensure, isUp, post } from './link'

const tabs = atom({ plugin: 'browser-pane', key: 'tabs' } as const, {} as Record<string, BrowserPaneTab>)
const data = atom({ plugin: 'browser-pane', key: 'data' } as const, {} as Record<string, BrowserPaneJson>)

const TAB_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const GUIDE = 'guide'
const NOT_ANSWERED = 'browser-pane did not answer'

// Each tab the server has not been told about yet is told when it (re)starts, with its latest data.
async function pushAll($: any) {
  const all = await read($, tabs)
  const latest = await read($, data)
  for (const tab of Object.values(all)) {
    await post($, '/control/register', tab)
    if (tab.id in latest) await post($, '/control/data', { tab: tab.id, data: latest[tab.id] })
  }
}

const isAbsolute = (p: unknown) => typeof p === 'string' && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p))

function checkTab(tab: BrowserPaneTab): string | undefined {
  if (!TAB_ID.test(String(tab.id)) || tab.id === GUIDE) return `tab id "${tab.id}" must be lowercase letters, digits and dashes, and not "${GUIDE}"`
  if (typeof tab.title !== 'string' || tab.title.trim() === '') return 'a tab needs a title'
  if (!isAbsolute(tab.root)) return 'a tab root must be an absolute folder'
  if (tab.server !== undefined && !isAbsolute(tab.server)) return 'a tab server must be an absolute path'
  return undefined
}

export const register: Register = on => {
  // The methods' bodies stand beneath this mod's hooks: a caller reaches them only when the hooks
  // didn't answer (one failed or ran out of time), so each says so in its own result.
  on('engine.create', async (_$, e, next) => {
    const built = await next(e)
    return {
      ...built,
      browserPane: {
        register: async (): Promise<BrowserPaneRegisterResult> => ({ isRegistered: false, reason: NOT_ANSWERED }),
        show: async (): Promise<BrowserPaneShowResult> => ({ isOpened: false, reason: NOT_ANSWERED }),
        update: async (): Promise<BrowserPaneUpdateResult> => ({ isSent: false, reason: NOT_ANSWERED }),
      },
    }
  })

  on('browserPane.register', async ($, e) => {
    const tab: BrowserPaneTab = { id: e.id, title: e.title, root: e.root }
    if (e.server !== undefined) tab.server = e.server
    if (e.description !== undefined) tab.description = e.description
    if (e.pinned !== undefined) tab.pinned = e.pinned === true
    const problem = checkTab(tab)
    if (problem) return { value: { isRegistered: false, reason: problem } }
    await update($, tabs, all => ({ ...all, [tab.id]: tab }))
    if (isUp()) await post($, '/control/register', tab)
    return { value: { isRegistered: true } }
  })

  on('browserPane.update', async ($, e) => {
    if (!(e.tab in (await read($, tabs)))) return { value: { isSent: false, reason: `no tab "${e.tab}"` } }
    const value = e.data
    await update($, data, all => ({ ...all, [e.tab]: value }))
    if (!isUp()) return { value: { isSent: false, reason: 'the window is not open; kept for when it opens' } }
    const answer = await post($, '/control/data', { tab: e.tab, data: value })
    return { value: answer ? { isSent: true } : { isSent: false, reason: 'the server did not answer' } }
  })

  on('browserPane.show', async ($, e) => {
    const tab = e.tab ?? GUIDE
    if (tab !== GUIDE && !(tab in (await read($, tabs)))) return { value: { isOpened: false, reason: `no tab "${tab}"` } }
    if (e.data !== undefined && tab !== GUIDE) await update($, data, all => ({ ...all, [tab]: e.data }))
    // A server that starts now is told every tab's latest data as it comes up, this one's included.
    const wasUp = isUp()
    const failure = await ensure($, () => pushAll($))
    if (failure) return { value: { isOpened: false, reason: failure } }
    if (wasUp && e.data !== undefined && tab !== GUIDE) await post($, '/control/data', { tab, data: e.data })
    const answer = await post($, '/control/show', { tab, select: e.select })
    if (!answer) return { value: { isOpened: false, reason: 'the server did not answer' } }
    return { value: answer.isOpened ? { isOpened: true, how: answer.how } : { isOpened: false, reason: answer.reason ?? 'no window opened' } }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'browser-pane',
      description: 'Open the shared browser window: /browser-pane [tab]',
    })
    return next(e)
  })

  on('command.run', { command: 'browser-pane' }, async ($, e) => {
    const tab = e.args.trim() || undefined
    const r = await $.browserPane.show(tab ? { tab } : {})
    if (r.isOpened) return { text: r.how === 'reused' ? 'browser-pane: switched the open window.' : 'browser-pane: window opened.' }
    return { text: `browser-pane: no window (${r.reason}).` }
  })
}
