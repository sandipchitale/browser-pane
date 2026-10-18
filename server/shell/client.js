// browser-pane's helper for a tab's page. Load it in <head>, before the page's styles paint:
//
//   <script src="/bp/client.js"></script>
//
//   browserPane.onSelect(select => ...)  what Claude Code asked the tab to select (show({ select })),
//                                        the one the page opened with first
//   browserPane.onRefresh(() => ...)     the window's Refresh button, while this tab shows; a page
//                                        that registers none is reloaded instead
//   browserPane.onTheme(theme => ...)    'light' or 'dark', each time it changes
//   browserPane.theme                    'light' or 'dark' now; also <html data-theme>, set before
//                                        the page paints, for CSS: [data-theme="dark"] ...
//   browserPane.api(path, init)          fetch(`api/${path}`): the tab's server module
//   browserPane.tab                      this tab's id
//
// The window owns the theme (its toolbar picks System, Light or Dark) and the Refresh button, so a
// tab draws neither.
'use strict'
;(() => {
  const THEME_KEY = 'browser-pane-theme'
  const match = /^\/tab\/([^/]+)\//.exec(location.pathname)
  const handlers = { select: [], refresh: [], theme: [] }
  let pending = new URLSearchParams(location.search).get('select') ?? undefined

  // The window and its tabs share one origin, so they read the same choice.
  const resolve = () => {
    let mode = 'system'
    try {
      mode = localStorage.getItem(THEME_KEY) || 'system'
    } catch {}
    return mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'
  }
  const applyTheme = theme => {
    if (document.documentElement.dataset.theme === theme) return
    document.documentElement.dataset.theme = theme
    for (const fn of handlers.theme) fn(theme)
  }
  applyTheme(resolve())
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(resolve()))

  const deliver = select => {
    if (handlers.select.length === 0) pending = select
    for (const fn of handlers.select) fn(select)
  }

  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== window.parent) return
    const msg = event.data
    if (!msg || typeof msg.type !== 'string') return
    if (msg.type === 'browser-pane:select' && typeof msg.select === 'string') deliver(msg.select)
    else if (msg.type === 'browser-pane:theme' && (msg.theme === 'light' || msg.theme === 'dark')) applyTheme(msg.theme)
    else if (msg.type === 'browser-pane:refresh') {
      if (handlers.refresh.length === 0) location.reload()
      else for (const fn of handlers.refresh) fn()
    }
  })

  window.browserPane = {
    tab: match ? decodeURIComponent(match[1]) : undefined,
    get theme() {
      return document.documentElement.dataset.theme
    },
    onSelect(fn) {
      handlers.select.push(fn)
      if (pending !== undefined) {
        const select = pending
        pending = undefined
        queueMicrotask(() => fn(select))
      }
    },
    onRefresh(fn) {
      handlers.refresh.push(fn)
    },
    onTheme(fn) {
      handlers.theme.push(fn)
    },
    api(path, init) {
      return fetch(`/tab/${match ? match[1] : ''}/api/${String(path).replace(/^\/+/, '')}`, { cache: 'no-store', ...init })
    },
  }
})()
