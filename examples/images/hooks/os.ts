// Opening and revealing a file differs per OS and the mod can't read the OS,
// so each command is tried in turn and the first that works is used.
type Run = (argv: string[]) => Promise<{ exitCode: number }>

const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, '') || '/'

async function firstOk(run: Run, attempts: { argv: string[]; trustExit?: boolean }[]) {
  for (const a of attempts) {
    try {
      const r = await run(a.argv)
      if (r.exitCode === 0 || a.trustExit) return true
    } catch {
      // command not installed: try the next one
    }
  }
  return false
}

export const openArgv = (p: string) => [
  { argv: ['open', p] },
  { argv: ['xdg-open', p] },
  { argv: ['cmd', '/c', 'start', '', p] },
]

// explorer.exe exits 1 even when it worked, so its attempt is trusted.
export const revealArgv = (p: string) => [
  { argv: ['open', '-R', p] },
  { argv: ['explorer', `/select,${p}`], trustExit: true },
  { argv: ['xdg-open', dirname(p)] },
]

export const openFile = (run: Run, p: string) => firstOk(run, openArgv(p))
export const revealFile = (run: Run, p: string) => firstOk(run, revealArgv(p))
