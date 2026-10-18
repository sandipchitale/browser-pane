# Integrating with browser-pane

For why browser-pane exists, and a step-by-step path from a copy of this template to a published mod, see the [integration guide](https://github.com/sandipchitale/browser-pane/blob/main/INTEGRATION_GUIDE.md). This file is the contract itself.

This mod draws its UI as a tab in **browser-pane**'s shared browser window. browser-pane is a separate mod that owns the window, the local web server and the security around them. This mod owns three things: a page, an optional Node module that answers the page's requests, and the hooks that tell browser-pane about them.

```
this mod's hooks ── $.browserPane.register / show / update ──▶ browser-pane ──▶ its local server (Node, 127.0.0.1)
                                                                                 │
              Chrome app window: tab strip + Guide ◀── /tab/<id>/        this mod's tab/ (static files)
                                                     /tab/<id>/api/…    this mod's tab-server/server.mjs
```

One window serves every mod's tabs. The **Guide** tab lists them, and the icons at the right of the tab strip are the window's: **Refresh** (the tab showing) and **Theme** (one button each for System, Light and Dark).

## Files

| File | What it is |
|---|---|
| `.claude-plugin/plugin.json` | The manifest. `"dependencies": ["browser-pane"]` is what makes this a browser-pane mod. |
| `.claude-plugin/marketplace.json` | This mod's own marketplace: it lists this mod (`./`) and browser-pane (from GitHub). |
| `hooks/register.ts` | The hooks: register the tab, show it from a command, and fall back when there is no window. |
| `tab/index.html` | The tab's page: static files served at `/tab/<id>/`. |
| `tab-server/server.mjs` | The tab's server module: Node code that answers `/tab/<id>/api/…`. Optional. |
| `hooks/register.test.ts`, `tab-server/server.test.mjs` | Tests for each side. |

## 1. Depend on browser-pane

In `.claude-plugin/plugin.json`:

```json
"dependencies": ["browser-pane"]
```

- **The dependency is hard.** Claude Code loads this mod only when browser-pane is installed and enabled. Without it, the mod fails to load with `dependency-unsatisfied`, and none of its code runs.
- **Types come with it.** When Claude Code loads this mod from a folder it develops in, it lays browser-pane's contract into `.claude-plugin/types/browser-pane/index.d.ts`. So `$.browserPane` and its arguments are typed, and `tsc -p .` checks them. That folder is generated; keep it out of git.
- **A bare name is looked up in this mod's own marketplace.** That is why `marketplace.json` lists browser-pane next to this mod:

  ```json
  { "name": "browser-pane", "source": { "source": "github", "repo": "sandipchitale/browser-pane" } }
  ```

  Installing this mod from its marketplace then installs browser-pane too, in one step. If several mods each list browser-pane this way, only one copy loads: the others are skipped, since they share the name.

## 2. Register the tab: `$.browserPane.register(tab)`

Call it from `session.start`. It is cheap: browser-pane starts nothing until the first `show`.

| Field | |
|---|---|
| `id` | Lowercase letters, digits and dashes, unique across mods (use your mod's name), not `guide`. The tab's URL is `/tab/<id>/`. |
| `title` | The label on the tab. |
| `root` | Absolute folder of the static files, `index.html` at least: `` `${$.plugin.root}/tab` ``. |
| `server` | Optional absolute path of the server module: `` `${$.plugin.root}/tab-server/server.mjs` ``. |
| `description` | One line for the Guide tab. |
| `pinned` | Optional. `true` puts the tab first in the Guide and the tab strip, with a pin. It's a default: the person pins and unpins tabs in the Guide, and the window remembers their choice. |

Result: `{ isRegistered: true }`, or `{ isRegistered: false, reason }` for a bad id or a relative path.

Register again with the same `id` to change a tab. browser-pane keeps registrations in the session's state, so they survive a reload of browser-pane itself.

## 3. Show it: `$.browserPane.show({ tab, select?, data? })`

```ts
const r = await $.browserPane.show({ tab: 'template', select: 'item-3', data: { session } })
if (!r.isOpened) {
  // r.reason: no $.process here (desktop app, IDE), Node missing, server didn't start, unknown tab...
}
```

- It starts browser-pane's server if needed, then opens the window on the tab.
- If the window is already open, it switches that window to the tab. It never opens a second window: `r.how` is `'reused'` rather than `'opened'`.
- `select` (a string) reaches the page through `browserPane.onSelect`.
- `data` (plain JSON) reaches the server module through `update`, before the tab shows.
- **Always handle `isOpened: false`.** The window needs `$.process`, which only the CLI has. In the desktop app or an IDE extension, say why, or show the content another way, for example in a `Pane`.

## 4. Send data without showing: `$.browserPane.update({ tab, data })`

This hands the server module new data without bringing the window forward. Use it for state that changes while the window may be closed, and call it once from `session.start` for anything the module needs even when the user opens the tab from the Guide.

- **Only the latest data is kept,** per tab. If the window has never opened, the data waits (`isSent: false` with a reason) and is delivered when the server starts.
- **It is sent again** whenever browser-pane's server restarts. So send state, not events. If you must send events, give each one a unique key and have the module skip a key it has seen (the editors example does this for its live feed).

## 5. The page: `tab/`

Load the client in `<head>`, so the window's theme applies before the page paints:

```html
<script src="/bp/client.js"></script>
```

| API | |
|---|---|
| `browserPane.onSelect(fn)` | `fn(select)` for each `show({ select })`. Also called once with the selection the page was opened with. |
| `browserPane.onRefresh(fn)` | The window's Refresh icon, while this tab shows. A page that registers no handler is reloaded instead. |
| `browserPane.onTheme(fn)` | `fn('light' \| 'dark')` when the theme changes. |
| `browserPane.theme` | `'light'` or `'dark'` now. |
| `browserPane.api(path, init)` | `fetch` of `/tab/<id>/api/<path>`: your server module. |
| `browserPane.tab` | This tab's id. |

- **Theme:** style the page from `<html data-theme="light|dark">`, which the client keeps in step: `:root[data-theme="dark"] { ... }`. Don't draw a theme picker or a refresh button; the window has them.
- **Paths:** use relative paths in the page (`style.css`, `api/info`) or `browserPane.api`.
- **What is served:** every file under `root` except dotfiles, and links that lead outside `root`. A file added while you develop is found on a later request (the list is read again on a miss, at most once a second). Pages are served fresh, so after editing one, press Refresh in the window (or ⌘R).
- **Authentication:** the page needs no token. The window's cookie authenticates its requests.

## 6. The server module: `tab-server/server.mjs`

An ES module that runs inside browser-pane's Node server. Its default export is called once for the tab and returns the tab's handlers:

```js
export default function create({ id, root }) {
  let data = {}
  return {
    update(next) { data = next },                  // from show({ data }) and update(); latest wins
    async handle(req, res, sub) {                  // Node's req/res; sub = the path below api/
      if (req.method === 'GET' && sub === 'info') { res.end(JSON.stringify(data)); return true }
      return false                                 // 404
    },
  }
}
```

- `sub` has no query string. Read the query from `new URL(req.url, 'http://x').searchParams`.
- Return `false` for 404. If the module throws, only that request fails (500), and only this tab is affected. If the module fails to load, the Guide shows the error, and the tab's static files are still served.
- **Requests are checked before they reach `handle`:** the window's token (a cookie named for the server's port), the `Host` header, and `Sec-Fetch-Site`, which refuses pages from other local origins.
- **Your part of the safety rules:**
  - Never serve or open a path the page sends. Keep your own list, and let the page name items by number or id.
  - Run commands as argv arrays (`spawn(cmd, args)`), never through a shell.
  - Validate every argument.
- **The process's working folder is not the session's.** If the module needs the session's folder or id, send them as `data`.
- **Node caches modules.** browser-pane imports the module again when the file's modification time changed and the tab registers again, which happens when this mod reloads. A module that two tabs share is one instance, so its top-level state is shared between them.

## 7. Test it

- `claude plugin test .` runs `hooks/*.test.ts` against the engine.
  - **The test kit loads no dependencies,** so a test brings browser-pane inline: a plugin whose `engine.create` adds `$.browserPane`, and whose `browserPane.*` hooks answer. `hooks/register.test.ts` shows how; it records each call through `$.http.fetch`.
  - **A module that hooks `browserPane.*` events needs a provider loaded,** or it fails to load. Calling the methods is fine either way.
  - Event names in `on(...)` must be string literals.
- `node --test tab-server/` tests the server module behind a small HTTP server of its own, so no browser-pane is needed.
- `claude plugin validate .` checks the manifest, the marketplace and the hooks module. Type-check with `tsc -p .` once Claude Code has loaded the mod and laid its types.

## 8. Develop it

- **Load it with hot reload,** next to browser-pane. Either run `claude --plugin-dir <this folder> --plugin-dir <browser-pane folder>`, or put this folder (a symlink works) in the mods folder of a session that hot-reloads. Saving a hooks file reloads the mod when the turn ends.
- **What a reload covers:**
  - Page files are served fresh: press Refresh.
  - The server module is imported again when the mod reloads and registers the tab again.
  - browser-pane's own server code only changes when its server restarts: when browser-pane reloads, or when its idle timer ends a minute after the session's heartbeat stops.

## Make it yours

When you copy this folder for a new mod, change these names together:

1. **The mod's name:** `name` in `.claude-plugin/plugin.json`, and the entry for this mod in `.claude-plugin/marketplace.json`, along with the marketplace's own `name`.
2. **The tab:** `TAB` and `TITLE` in `hooks/register.ts`, and the `description` passed to `register`.
3. **The command:** the literal `'template'` in `$.command.register({ name })` and in the `command.run` matcher (keep them literals), and the texts that mention it.
4. **The page:** `<title>` and the words in `tab/index.html`.
5. **The tests:** the ids and texts they expect.
6. **The docs and license:** `README.md` (and the author in `LICENSE`, if it isn't yours).

Then build out `tab/` and `tab-server/server.mjs`, keeping the rules above: state in `update`, no paths from the page, argv-only commands, and a fallback when `isOpened` is false.

## Publish it

Make the folder a GitHub repository of its own. Its `.claude-plugin/marketplace.json` already lists this mod and browser-pane, so one line installs both:

```
/plugin install <your-mod> --marketplace <owner>/<repo>
```
