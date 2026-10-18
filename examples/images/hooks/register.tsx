import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ImagesFile } from '../types'
import { openFile, revealFile } from './os'
import { droppedImagePath, tokens } from './paths'

const draft = atom({ plugin: 'browser-pane-images', key: 'draft' } as const, '')
const files = atom({ plugin: 'browser-pane-images', key: 'files' } as const, {} as Record<string, ImagesFile>)
const origins = atom({ plugin: 'browser-pane-images', key: 'origins' } as const, {} as Record<string, string>)
// Images the user cleared from the pane, so a rescan doesn't bring them back.
const cleared = atom({ plugin: 'browser-pane-images', key: 'cleared' } as const, {} as Record<string, boolean>)

const TAB = 'images'
const PANE = 'browser-pane-images'

// Dropped or pasted file paths not yet matched to an [Image #N] chip.
let pending: string[] = []

// Icon labels of one width, so the buttons match.
const PAD = (icon: string) => `  ${icon}  `

// What the tab's server module needs: the session's folder, and where dropped files came from.
async function tabData($: any) {
  return { session: await $.session.id(), origins: await read($, origins) }
}

async function scan($: any) {
  const sid = await $.session.id()
  const r = await $.process.run(['find', '/private/tmp', '/tmp', '-maxdepth', '5', '-path', `*/${sid}/images/*`])
  const gone = await read($, cleared)
  const found: Record<string, ImagesFile> = {}
  for (const line of r.stdout.split('\n')) {
    const m = /\/images\/(\d+)\.[A-Za-z]+$/.exec(line.trim())
    if (m && !gone[m[1]]) found[m[1]] = { path: line.trim() }
  }
  await update($, files, cur => ({ ...cur, ...found }))
}

async function locate($: any, n: number) {
  const sid = await $.session.id()
  const r = await $.process.run(['find', '/private/tmp', '/tmp', '-maxdepth', '5', '-path', `*/${sid}/images/${n}.*`])
  const path = r.stdout.split('\n').find((l: string) => l.trim())
  if (path) {
    await update($, files, m => ({ ...m, [n]: { path } }))
  }
}

async function clearAll($: any) {
  const ids = Object.keys(await read($, files))
  await update($, cleared, m => ({ ...m, ...Object.fromEntries(ids.map(id => [id, true])) }))
  await update($, files, () => ({}))
}

async function openPane($: any) {
  await scan($)
  await $.ui.open({ id: PANE, title: 'Images', focus: true })
}

// A chip shows its image in the Images tab, or in the OS viewer when the window can't open.
async function showInWindow($: any, n: number) {
  const r = await $.browserPane.show({ tab: TAB, select: String(n), data: await tabData($) })
  if (r.isOpened) {
    const where = r.how === 'reused' ? 'the open Images tab. It may be behind other windows' : 'the Images tab'
    await $.ui.toast(`Image #${n} is shown in ${where}.`)
    return
  }
  await $.ui.toast(`The browser window can't open (${r.reason}). Opening Image #${n} in your OS viewer.`)
  await show($, n)
}

async function show($: any, n: number) {
  const run = (argv: string[]) => $.process.run(argv)
  const origin = (await read($, origins))[n]
  // The dropped file may have been moved since, so the saved copy is the fallback.
  if (origin && (await openFile(run, origin))) return true
  let have = (await read($, files))[n]
  if (!have) {
    await locate($, n)
    have = (await read($, files))[n]
  }
  if (have && (await openFile(run, have.path))) return true
  await $.ui.toast(`Image #${n} isn't saved yet or can't be found`)
  return false
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.browserPane.register({
      id: TAB,
      title: 'Images',
      root: `${$.plugin.root}/tab`,
      server: `${$.plugin.root}/tab-server/server.mjs`,
      description: "This session's pasted and dropped images: preview them, open them in your OS viewer, show them in Finder.",
    })
    // Opened from the Guide tab, the Images tab still needs to know the session.
    await $.browserPane.update({ tab: TAB, data: await tabData($) })
    await $.command.register({
      name: 'images',
      description: "Browse this session's images in the browser-pane window: /images [n | pane]",
    })
    return next(e)
  })

  on('command.run', { command: 'images' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'pane') {
      await openPane($)
      return { text: 'Images pane opened.' }
    }
    const n = Number(arg)
    if (n) {
      const ok = await show($, n)
      return { text: ok ? `Opened Image #${n}.` : `Image #${n} not found.` }
    }
    const r = await $.browserPane.show({ tab: TAB, data: await tabData($) })
    if (r.isOpened) return { text: r.how === 'reused' ? 'images: switched the open window to the Images tab.' : 'images: window opened.' }
    await openPane($)
    return { text: `images: the browser window can't open (${r.reason}), so the Images pane opened instead.` }
  })

  on('prompt.edit', async ($, e, next) => {
    const result: any = await next(e)
    const after: string = result?.text ?? e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    await update($, draft, () => after)
    if (after.trim() === '') pending = []
    const dropped = droppedImagePath(e.inputText)
    if (dropped) pending.push(dropped)
    const before = new Set(tokens(e.text))
    let learned = false
    for (const n of tokens(after)) {
      if (before.has(n)) continue
      const origin = pending.shift()
      if (origin) {
        await update($, origins, m => ({ ...m, [n]: origin }))
        learned = true
      }
    }
    // The tab lists a dropped file from where it came from, so it hears of each new one.
    if (learned) await $.browserPane.update({ tab: TAB, data: await tabData($) })
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, draft, () => '')
    pending = []
    const sent = await next(e)
    await scan($).catch(() => {})
    return sent
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e)
    // Other plugins' rows (and the engine's) stay, below this one.
    const [text, beneath] = await Promise.all([read($, draft), next(e)])
    const ns = [...new Set(tokens(text))]
    if (ns.length === 0) return beneath
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {ns.map(n => (
            <Button key={`img-${n}`} plain onPress={() => showInWindow($, n)}>
              {`🖼  Image #${n}`}
            </Button>
          ))}
        </Box>
        {beneath}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const known = await read($, files)
    const origin = await read($, origins)
    const shown = (n: number) => origin[n] ?? known[n].path
    const ids = Object.keys(known).map(Number).sort((a, b) => a - b)
    // Tooltips are the last children of the root, so nothing paints over them:
    // an absolute Box paints over siblings before it only. Each joins its
    // button's hover scope, and sits at a position the fixed layout gives.
    const ROW0 = 4
    const ROWH = 3
    const COLS = [2, 14, 26]
    const tip = (key: string, top: number, left: number, text: string) => (
      <Box
        key={`card-${key}`}
        position="absolute"
        top={top}
        left={left}
        display="none"
        hover={{ display: 'flex', scope: key }}
        borderStyle="round"
        backgroundColor="inverseText"
        paddingX={1}
      >
        <Text color="text">{text}</Text>
      </Box>
    )
    return (
      <Box flexDirection="column" paddingX={1} paddingBottom={4}>
        <Box key="clear-box" hover={{ scope: 'tip-clear' }} alignSelf="flex-start">
          <Button key="clear" onPress={() => clearAll($)}>
            {PAD('🧹')}
          </Button>
        </Box>
        <Text> </Text>
        <Text bold>Images in this session</Text>
        <Text> </Text>
        {ids.length === 0 && <Text dimColor>No images yet.</Text>}
        {ids.map(n => (
          <Box
            key={`row-${n}`}
            flexDirection="row"
            alignItems="center"
            gap={2}
            paddingX={1}
            paddingY={1}
            hover={{ backgroundColor: 'subtle' }}
          >
            <Box key={`reveal-box-${n}`} hover={{ scope: `tip-reveal-${n}` }}>
              <Button key={`reveal-${n}`} onPress={() => revealFile((argv: string[]) => $.process.run(argv), shown(n))}>
                {PAD('📂')}
              </Button>
            </Box>
            <Box key={`copy-box-${n}`} hover={{ scope: `tip-copy-${n}` }}>
              <Button key={`copy-${n}`} onPress={(press: any) => $.ui.copy({ text: shown(n), surface: press.surface })}>
                {PAD('📋')}
              </Button>
            </Box>
            <Box key={`view-box-${n}`} hover={{ scope: `tip-view-${n}` }}>
              <Button key={`view-${n}`} onPress={() => show($, n)}>
                {PAD('👀')}
              </Button>
            </Box>
            <Button key={`open-${n}`} plain onPress={() => show($, n)}>
              {`[Image #${n}]`}
            </Button>
          </Box>
        ))}
        {tip('tip-clear', 1, 1, 'Clear list')}
        {ids.map((n, i) => {
          const rowTop = ROW0 + i * ROWH
          // Below the row, unless the card would run past the bottom edge of the
          // window as scrolled: then above the button (the card is 3 rows tall,
          // the button on the row's middle line).
          const offset = e.props?.scroll?.offset ?? 0
          const room = e.props?.scroll?.bodyRows ?? e.viewport?.rows ?? 24
          const below = rowTop + ROWH + 3 - offset > room ? rowTop - 2 : rowTop + ROWH
          return [
            tip(`tip-reveal-${n}`, below, COLS[0], 'Show in Finder'),
            tip(`tip-copy-${n}`, below, COLS[1], 'Copy path'),
            tip(`tip-view-${n}`, below, COLS[2], 'View in OS preview'),
          ]
        })}
      </Box>
    )
  })
}
