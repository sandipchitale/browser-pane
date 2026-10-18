# This mod is built on browser-pane

It draws its UI as a tab in browser-pane's shared browser window, through `$.browserPane`. Before changing the hooks, the page (`tab/`) or the server module (`tab-server/`), read `integration.md`: it says what browser-pane does and what this mod must do.

- Keep `"dependencies": ["browser-pane"]` in `.claude-plugin/plugin.json`, and browser-pane listed in `.claude-plugin/marketplace.json`.
- Always handle `show`'s `isOpened: false`: the window exists only where `$.process` does (the CLI).
- The page loads `/bp/client.js` in `<head>`, styles itself from `data-theme`, and draws no theme picker or refresh button.
- The server module never serves or opens a path the page sends, and runs commands as argv arrays, never through a shell.
- When this folder is a fresh copy, rename it first: see "Make it yours" in `integration.md`.
- Test with `claude plugin test .` and `node --test tab-server/`; check with `claude plugin validate .`.
