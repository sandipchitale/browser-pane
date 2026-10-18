# Integration guide

How to build a Claude Code mod whose UI is a web page, with everything the browser can do, on top of browser-pane: why browser-pane exists and how it is shaped, then a step-by-step path from a copy of the template to a published mod, developed with Claude Code.

- [Part 1: Why browser-pane](#part-1-why-browser-pane)
- [Part 2: Build a mod, step by step](#part-2-build-a-mod-step-by-step)
- [Reference](#reference)

---

## Part 1: Why browser-pane

### Beyond the terminal

A Claude Code mod draws with the terminal's cell grid: boxes, text, buttons, inputs, selects. That fits a status line, a band above the prompt or a small pane, and it stops there. Every interaction has to be squeezed into characters and keystrokes.

The browser is the richest UI runtime there is, and it is already on every machine. A mod that can open a browser page is no longer limited to what a terminal can draw. It can use the whole web platform:

| What a mod could do | With |
|---|---|
| 3D scenes, models and visualizations | WebGL, WebGPU, Three.js |
| Parametric CAD: design a part, preview it, export STL | JSCAD, OpenCascade.js |
| Rich editors: code, diagrams, forms, trees, tables | Monaco, CodeMirror, SVG, the DOM |
| Charts and live dashboards | Canvas, D3, any charting library |
| Music and sound: play, record, synthesize | Web Audio, Web MIDI |
| Talking to Claude Code: speech in, speech out | SpeechRecognition (STT), SpeechSynthesis (TTS) |
| Live video and calls | getUserMedia, WebRTC |
| Images, video and documents: view, annotate, compare | img, video, canvas, PDF.js |
| Direct manipulation: drag and drop, drawing, pointer and touch input | Pointer Events, Drag and Drop |

The terminal stays where the conversation happens. The browser becomes where a mod shows what the conversation is about, and where you work with it in ways that text can't express. Claude Code's hooks connect the two: a command, a tool call or a finished turn can bring a page forward with new content, and the page can act on your machine through its mod.

### Why a shared mod, and not each mod on its own

Any mod could run its own local web server and open its own browser window. Each would then re-solve the same problems, and each could get them wrong:

- **The server's life:** starting a server process, finding its port, keeping it alive while the session runs, and stopping it afterwards.
- **The window:** opening an app window, and reusing it instead of opening another each time. With Chrome this takes care, because a second launch with the same profile is handed to the running process.
- **Security:** a local web server is reachable by every web page you visit, so it needs to bind to 127.0.0.1, check the `Host` header, require a secret token, and never serve a path a page asks for.

browser-pane solves them once. It owns one window, one server and the security around them, and each mod contributes a **tab**:

```
your mod ── $.browserPane.register / show / update ──▶ browser-pane ──▶ one local server (Node, 127.0.0.1)
                                                                          │
         one browser window: Guide + a tab per mod ◀── /tab/<id>/       your page: any HTML, CSS, JS
                                                       /tab/<id>/api/…  your server module: any Node
```

A mod then writes only what is its own: a web page, and optionally a Node module that gives the page access to the machine (files, commands, the `claude` CLI). Several mods share one window, with a **Guide** tab that lists them all.

### How it is shaped, and why

**A noun on `$`.** browser-pane adds `$.browserPane` to every mod's engine interface, with three methods: `register`, `show` and `update`. A mod calls it like any built-in noun.

- **Typed:** browser-pane ships a contract (`types/index.d.ts`), and a mod that depends on browser-pane gets it laid into its own types folder, so `$.browserPane` is typed there.
- **Hookable:** each method is also an event (`browserPane.show`), so other mods can observe or wrap it.
- **No private protocol** for mods to agree on.

**A hard dependency, with browser-pane in your marketplace.** How Claude Code handles `"dependencies"` today:

- A mod that lists `browser-pane` is loaded only when browser-pane is installed.
- A bare dependency name is looked up in the mod's own marketplace. So a mod's marketplace lists browser-pane next to the mod, and one install line installs both.
- If several mods each list browser-pane, only one copy loads; the others are skipped by name.

**A tab is any web page, plus an optional server module.**

- The page is static files in a folder. Use plain HTML and JavaScript, load libraries from a CDN, or ship a bundle you built.
- When the page needs the machine, the tab's server module runs in browser-pane's Node server and answers `/tab/<id>/api/…`.
- One module failing costs only its own tab.

**One window, reused.**

- The window is a Chrome app window in a profile of its own (your default browser without Chrome).
- The page polls the server. When a `show` arrives while the window is polling, that window switches tabs; otherwise a new window opens. So `show` never stacks windows.
- Tabs can be pinned to come first in the Guide and the tab strip.
- The window draws the controls every tab would otherwise repeat: **Refresh** and **Theme** (a button each for System, Light and Dark). Tabs follow them through a small client script.

**State, not events.** `update` hands a tab's server module data, and browser-pane keeps only the latest per tab, sending it again whenever its server restarts. A module therefore treats data as state. If a mod must stream events, it keys each one so the module can skip a repeat.

**Security in one place.**

- Everything binds to 127.0.0.1.
- Every request must name the server's own `Host`, which refuses DNS rebinding.
- The mod talks to the server with a per-run token in a header.
- The window gets the same token once, in the URL it opens on, and from then on as a cookie named for the server's port.
- Requests that the browser marks as coming from another site (`Sec-Fetch-Site`) are refused, because a page on another local port would otherwise send that cookie along.
- A tab serves only files under its own folder: no dotfiles, and no links that lead outside it.
- What a mod still owns: never serve or open a path the page sends, and run commands as argv arrays, never through a shell.

**Browser permissions work as on any site.** Pages are served from `http://127.0.0.1`, which the browser treats as a secure context, so the microphone, camera, MIDI and similar APIs are available to a tab. The browser asks you the first time. Permissions are kept per origin, and the server's port changes with each session, so expect the browser to ask again in a new session.

**A fallback is part of the contract.** The window needs `$.process`, which only the Claude Code CLI has; the desktop app and IDE extensions don't. `show` then answers `{ isOpened: false, reason }`, and a mod shows its content another way, such as in a terminal `Pane`.

### What it is not, yet

- **A first-class surface.** A web view drawn by Claude Code itself would be simpler, safer and available on every surface. browser-pane is the way to have one today; the [request for a built-in one](https://github.com/anthropics/claude-code/issues/101910) is open.
- **A two-way bridge.** A page talks to its own server module. It can't yet call back into its mod's hooks or use `$`.
- **Tested everywhere.** It is built and tested on macOS with Chrome. Linux and Windows have fallbacks that are untested.

---

## Part 2: Build a mod, step by step

This path starts from the template, a small complete mod with every integration point wired up, and uses Claude Code to turn it into yours. `examples/template/integration.md` is the template's own reference: it travels with your copy, and its `CLAUDE.md` tells Claude Code to read it.

### Step 1: Have what browser-pane needs

- The Claude Code CLI, in a terminal (not the desktop app or an IDE extension, which have no `$.process`).
- Node.js on your PATH.
- Google Chrome. Without it, browser-pane opens your default browser.
- Git, and the GitHub CLI (`gh`) if you will publish.

### Step 2: Install browser-pane, and try the template

Inside Claude Code:

```
/plugin install browser-pane --marketplace sandipchitale/browser-pane
```

To see what you are starting from, install the template too and run it:

```
/plugin install browser-pane-template --marketplace sandipchitale/browser-pane
/template hello
```

A window opens on the **Template** tab, showing "hello", the data the mod sent to its server module, and a notes form that its server module keeps. Try the window's Refresh and Theme icons, and the Guide tab.

If you added the `browser-pane` marketplace before, run `/plugin marketplace update browser-pane` first.

### Step 3: Copy the template

From a shell:

```
git clone https://github.com/sandipchitale/browser-pane.git
cp -R browser-pane/examples/template ~/mods/my-mod
cd ~/mods/my-mod
```

Your copy is a complete mod with its own marketplace, tests and docs. Nothing in it points back to the clone, which you can delete.

If you installed the template in step 2, uninstall it now (`/plugin uninstall browser-pane-template`). Your copy still has the same name until you rename it, and two mods of one name don't both load.

### Step 4: Open Claude Code in the copy, with the copy loaded

```
claude --plugin-dir .
```

- Claude Code loads your copy from the folder, and its dependency resolves to the browser-pane you installed.
- The folder is watched: when you or Claude Code save a file, the mod reloads (after Claude Code's turn, when Claude Code made the edit).
- The template's `CLAUDE.md` is read as the project's instructions. It points Claude Code to `integration.md` and lists the rules to keep.

Check it works: `/template hi`.

### Step 5: Make it yours

Ask Claude Code to rename the copy. For example:

> Read integration.md. Rename this template to `my-mod`: the plugin name `my-mod`, the tab id `my-mod` with the title "My Mod", and the command `/my-mod`. Follow "Make it yours", update the tests and the README, and run the tests.

"Make it yours" in `integration.md` lists everything that changes together:

- the name in `plugin.json` and `marketplace.json`;
- the tab id and title;
- the command, kept a string literal where it is registered and matched;
- the page's title;
- the tests;
- the README.

Then run `/my-mod hi` to see your renamed tab.

### Step 6: Build what you want

Describe the mod you want. Say what the tab shows, what it does, and where its data comes from. For example:

> Turn the tab into a viewer for this repository's recent commits: a list on the left (hash, author, date, subject), the selected commit's diff on the right. The server module runs `git log` and `git show` as argv arrays, in the session's folder. `/my-mod <hash>` selects that commit. Handle `isOpened: false` by printing the latest five commits instead.

Claude Code works through the three parts, as `integration.md` lays them out:

| Part | File | What changes |
|---|---|---|
| Hooks | `hooks/register.ts` | What the mod registers, which commands show the tab, what data it sends, and the fallback. |
| Page | `tab/` | The UI. It loads `/bp/client.js` in `<head>`, styles itself from `data-theme`, reacts to `onSelect` and `onRefresh`, and calls its module with `browserPane.api(...)`. |
| Server module | `tab-server/server.mjs` | Node code: `update(data)` for what the mod sends, `handle(req, res, sub)` for the page's requests. |

Things worth telling Claude Code when they apply:

- **Folders and ids:** the module's process doesn't run in your session's folder. Send `cwd` and the session id as `data`, as the template sends `session`.
- **State, not events:** send state with `update`. If you stream events, give each a unique key.
- **Safety:** never serve or open a path the page sends. Keep a list and let the page name items by number or id.
- **No window:** decide what the mod does when `show` returns `isOpened: false`.

### Step 7: See your changes

| You changed | To see it |
|---|---|
| `hooks/*.ts` | It reloads after the turn; run your command again. |
| `tab/*` | Press **Refresh** in the window. If the page has its own refresh handler, press ⌘R to reload the page itself. |
| `tab-server/server.mjs` | It is imported again when the mod reloads and registers its tab again: save a hooks file (or ask Claude Code to touch one), then run your command. |

If the window says the session has ended, browser-pane's server stopped (it does when browser-pane reloads). Close the window and run your command again.

### Step 8: Test it

Ask Claude Code to keep the tests in step with the code, and run them:

```
claude plugin validate .      # the manifest, the marketplace, the hooks module
claude plugin test .          # hooks/*.test.ts against the engine
node --test tab-server/       # the server module
```

- The test kit loads no dependencies, so the hook tests bring a small browser-pane of their own. The template's `hooks/register.test.ts` shows how.
- The server module's tests run it behind a small HTTP server of their own, so they need no browser-pane.
- Once Claude Code has loaded the mod, it has laid the types in `.claude-plugin/types/`, and `tsc -p .` type-checks your calls to `$.browserPane`.

### Step 9: Publish it

Your folder is already shaped as a repository: its `.claude-plugin/marketplace.json` lists your mod (`./`) and browser-pane (from GitHub).

1. Check that `marketplace.json` names your mod, both the marketplace's `name` and your mod's entry, and that it still lists browser-pane.
2. Ask Claude Code to share the mod as a public (or private) GitHub repository. It scans the files for keys and personal data before anything is pushed. Or do it yourself:

   ```
   git init && git add . && git commit -m "my-mod 0.0.1"
   gh repo create <owner>/my-mod --public --source . --push
   ```

3. Anyone can then install your mod, browser-pane with it, in one line:

   ```
   /plugin install my-mod --marketplace <owner>/my-mod
   ```

`.claude-plugin/types/` is generated and is in the template's `.gitignore`.

---

## Reference

- [`examples/template/integration.md`](examples/template/integration.md): the full contract a mod works against. It covers `register`, `show` and `update` with every field and result, the page's client API, the server module's interface and rules, testing, the development loop, and "Make it yours".
- [`types/index.d.ts`](types/index.d.ts): browser-pane's typed contract.
- [`examples/images`](examples/images) and [`examples/editors`](examples/editors): two larger mods built on browser-pane. Images has a band of chips above the prompt and a terminal-pane fallback. Editors has three tabs sharing one server module, a live event feed, and usage meters.
- [README](README.md): installing browser-pane, its commands, and how it works.
