# browser-pane-template

A starter mod for [browser-pane](https://github.com/sandipchitale/browser-pane): a tab in browser-pane's shared browser window, with a page and a server module. `/template <text>` shows the text in the tab; the page reads the server module's data and keeps notes.

## Start your own mod from it

1. Copy this folder and give it your mod's name.
2. Open Claude Code in the copy and ask it to build what you want, for example: *"Rename this template to `my-mod` and turn the tab into a viewer for …"*. Its `CLAUDE.md` points Claude Code to `integration.md`, which explains how the mod and browser-pane fit together, and lists what to rename.

## Install

From browser-pane's repository, inside Claude Code (browser-pane comes with it):

```
/plugin install browser-pane-template --marketplace sandipchitale/browser-pane
```

This folder is also a marketplace of its own: it lists this mod and browser-pane. So a copy made into a repository of its own installs in one line too:

```
/plugin install browser-pane-template --marketplace <owner>/<repo>
```

It needs what browser-pane needs: the Claude Code CLI, Node.js and Google Chrome.

## Develop

```
claude plugin validate .
claude plugin test .          # the hooks
node --test tab-server/       # the server module
```

## License

MIT
