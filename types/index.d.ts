// The browser-pane contract: what this mod adds to `$`, and the state it keeps.
// A mod that lists "browser-pane" under "dependencies" gets this file laid into
// its own .claude-plugin/types/browser-pane/, so `$.browserPane` is typed there.

/**
 * A tab's data: plain JSON (objects, arrays, strings, numbers, booleans, null), as it crosses to the
 * tab's server module. Typed `unknown` because the engine freezes every argument deeply, and a
 * recursive JSON type is too deep for that.
 */
export type BrowserPaneJson = unknown

/**
 * A tab in the shared browser window, as a mod registers it.
 *
 * `root` is a folder of static files (an `index.html` at least), served at
 * `/tab/<id>/`. `server`, when given, is a Node ES module the shared server
 * imports; its default export is a BrowserPaneServerModule factory, and it
 * answers the tab's requests under `/tab/<id>/api/`.
 */
export type BrowserPaneTab = {
  /** Lowercase letters, digits and dashes; unique across mods (use your mod's name). */
  id: string
  /** The label on the tab. */
  title: string
  /** Absolute folder of the tab's static files. Usually `$.plugin.root + '/tab'`. */
  root: string
  /** Absolute path of the tab's server module (`.mjs`), if it has one. */
  server?: string
  /** One line for the Guide tab. */
  description?: string
  /**
   * Pinned tabs come first, in the Guide and the tab strip, with a pin. This is the tab's default;
   * the person pins and unpins tabs in the Guide, and the window remembers their choice.
   */
  pinned?: boolean
}

export type BrowserPaneRegisterResult = { isRegistered: boolean; reason?: string }

export type BrowserPaneShowArgs = {
  /** The tab to bring forward; the Guide tab when left out. */
  tab?: string
  /** What the tab should select, handed to its page (`onSelect`). */
  select?: string
  /** New data for the tab's server module (`update`), sent before the tab shows. */
  data?: BrowserPaneJson
}

/**
 * `opened`: a new window was asked for. `reused`: an open window switched to
 * the tab. `isOpened: false` comes with a reason: there is no `$.process`
 * here (desktop app, IDE), Node or the server would not start, or the tab is
 * unknown. A caller then shows the content its own way, say in a Pane.
 */
export type BrowserPaneShowResult = { isOpened: boolean; how?: 'opened' | 'reused'; reason?: string }

export type BrowserPaneUpdateArgs = { tab: string; data: BrowserPaneJson }
export type BrowserPaneUpdateResult = { isSent: boolean; reason?: string }

export type BrowserPane = {
  /** Adds or replaces a tab. Cheap: nothing starts until the first `show`. Call it from `session.start`. */
  register: (tab: BrowserPaneTab) => Promise<BrowserPaneRegisterResult>
  /** Opens the window (or reuses the open one) on a tab, optionally selecting something in it. */
  show: (args: BrowserPaneShowArgs) => Promise<BrowserPaneShowResult>
  /** Hands a tab's server module new data without bringing the window forward. Kept for the next start. */
  update: (args: BrowserPaneUpdateArgs) => Promise<BrowserPaneUpdateResult>
}

/**
 * What a tab's server module default-exports: called once per import with the
 * tab, it answers the tab's requests. It runs in the shared Node server.
 *
 * `handle` gets the request below `/tab/<id>/api/` (`sub` without a leading
 * slash) after the server checked its token and Host; it returns false to
 * answer 404. `update` receives each `show`/`update` data, latest wins.
 */
export type BrowserPaneServerModule = (tab: { id: string; root: string }) => {
  update?: (data: BrowserPaneJson) => void | Promise<void>
  handle?: (req: unknown, res: unknown, sub: string) => boolean | Promise<boolean>
}

declare module 'claude-code' {
  interface EngineInterface {
    browserPane: BrowserPane
  }
  interface PluginState {
    'browser-pane': {
      /** Registered tabs by id; kept across reloads of this mod, which consumers don't repeat. */
      tabs: Record<string, BrowserPaneTab>
      /** Each tab's latest data, pushed again when the server (re)starts. */
      data: Record<string, BrowserPaneJson>
    }
  }
}
