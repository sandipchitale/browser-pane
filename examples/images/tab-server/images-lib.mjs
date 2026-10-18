// Pure helpers for the Images tab server module: find a session's images and describe them.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

export const mimeOf = file => MIME[path.extname(file).slice(1).toLowerCase()]

const SAVED = /^(\d+)\.[A-Za-z0-9]+$/

const dirs = dir => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  } catch {
    return []
  }
}

// Claude Code saves a session's pasted images at <tmp>/claude-<uid>/<project>/<session>/images/N.<ext>.
export function findSaved(sid, roots = ['/private/tmp', '/tmp', os.tmpdir()]) {
  const found = {}
  if (!SESSION_ID.test(sid)) return found
  for (const root of roots) {
    for (const user of dirs(root).filter(d => d.startsWith('claude-'))) {
      for (const project of dirs(path.join(root, user))) {
        const folder = path.join(root, user, project, sid, 'images')
        let names = []
        try {
          names = fs.readdirSync(folder)
        } catch {}
        for (const name of names) {
          const m = SAVED.exec(name)
          if (m && mimeOf(name) && !found[m[1]]) found[m[1]] = path.join(folder, name)
        }
      }
    }
  }
  return found
}

// The rows of the table: a dropped file's original path wins while it still exists, else the saved copy.
export function buildList(sid, origins = {}, roots) {
  const saved = findSaved(sid, roots)
  const ids = new Set([...Object.keys(saved), ...Object.keys(origins)])
  const rows = []
  for (const id of ids) {
    if (!/^\d+$/.test(id)) continue
    const candidates = [
      [origins[id], 'dropped'],
      [saved[id], 'saved'],
    ]
    for (const [file, source] of candidates) {
      if (typeof file !== 'string' || !path.isAbsolute(file) || !mimeOf(file)) continue
      let st
      try {
        st = fs.statSync(file)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      rows.push({ n: Number(id), path: file, name: path.basename(file), source, size: st.size, mtimeMs: st.mtimeMs, mime: mimeOf(file) })
      break
    }
  }
  return rows.sort((a, b) => a.n - b.n)
}

// What opens or reveals a file on each OS, tried in turn (the first that works wins).
export const openAttempts = file => [
  { argv: ['open', file] },
  { argv: ['xdg-open', file] },
  { argv: ['cmd', '/c', 'start', '', file] },
]

// explorer.exe exits 1 even when it worked, so its attempt is trusted.
export const revealAttempts = file => [
  { argv: ['open', '-R', file] },
  { argv: ['explorer', `/select,${file}`], trustExit: true },
  { argv: ['xdg-open', path.dirname(file)] },
]
