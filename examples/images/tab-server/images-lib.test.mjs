import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as lib from './images-lib.mjs'

const SID = '0b0b0b0b-0000-4000-8000-000000000001'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'img-prev-'))
  const folder = path.join(root, 'claude-501', '-proj', SID, 'images')
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, '1.png'), 'png1')
  fs.writeFileSync(path.join(folder, '2.jpg'), 'jpg22')
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'x')
  // another session's images must not show up
  const other = path.join(root, 'claude-501', '-proj', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'images')
  fs.mkdirSync(other, { recursive: true })
  fs.writeFileSync(path.join(other, '9.png'), 'nope')
  return { root, folder }
}

test('finds only this session\'s images, any image extension', () => {
  const { root } = fixture()
  const found = lib.findSaved(SID, [root])
  assert.deepEqual(Object.keys(found).sort(), ['1', '2'])
  assert.ok(found['2'].endsWith('2.jpg'))
})

test('a bad session id finds nothing', () => {
  const { root } = fixture()
  assert.deepEqual(lib.findSaved('../../etc', [root]), {})
})

test('list: sorted, with size and mime; a dropped file wins over the saved copy', () => {
  const { root } = fixture()
  const dropped = path.join(root, 'shot.png')
  fs.writeFileSync(dropped, 'dropped!')
  const rows = lib.buildList(SID, { 1: dropped }, [root])
  assert.deepEqual(rows.map(r => [r.n, r.source, r.name]), [[1, 'dropped', 'shot.png'], [2, 'saved', '2.jpg']])
  assert.equal(rows[0].size, 8)
  assert.equal(rows[1].mime, 'image/jpeg')
})

test('list: a moved dropped file falls back to the saved copy', () => {
  const { root } = fixture()
  const rows = lib.buildList(SID, { 1: path.join(root, 'gone.png') }, [root])
  assert.deepEqual(rows.map(r => [r.n, r.source]), [[1, 'saved'], [2, 'saved']])
})

test('list: ignores non-image, relative and non-numeric entries', () => {
  const { root } = fixture()
  const txt = path.join(root, 'a.txt')
  fs.writeFileSync(txt, 'x')
  const rows = lib.buildList(SID, { 5: txt, 6: 'rel/pic.png', abc: path.join(root, 'x.png') }, [root])
  assert.deepEqual(rows.map(r => r.n), [1, 2])
})

test('open and reveal fall through mac, linux, windows', () => {
  assert.deepEqual(lib.openAttempts('/a/1.png').map(a => a.argv[0]), ['open', 'xdg-open', 'cmd'])
  const r = lib.revealAttempts('/a/b/1.png')
  assert.deepEqual(r[1].argv, ['explorer', '/select,/a/b/1.png'])
  assert.deepEqual(r[2].argv, ['xdg-open', '/a/b'])
})
