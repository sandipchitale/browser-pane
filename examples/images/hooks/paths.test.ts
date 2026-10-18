import { test, expect } from 'claude-code/testing'
import { openArgv, revealArgv } from './os'
import { droppedImagePath, tokens } from './paths'

test('token regex matches image chips', () => {
  expect(tokens('a [Image #1] b [Image 2]')).toEqual([1, 2])
  expect(tokens('no images here')).toEqual([])
})

test('dropped path: plain, quoted, escaped and file:// forms', () => {
  expect(droppedImagePath('/a/b.png')).toBe('/a/b.png')
  expect(droppedImagePath("'/a/my pic.PNG'")).toBe('/a/my pic.PNG')
  expect(droppedImagePath('/a/my\\ pic.jpg')).toBe('/a/my pic.jpg')
  expect(droppedImagePath('file:///a/my%20pic.png')).toBe('/a/my pic.png')
})

test('dropped path: a literal % does not throw', () => {
  expect(droppedImagePath('/Users/me/100%.png')).toBe('/Users/me/100%.png')
  expect(droppedImagePath('/a/%20b.png')).toBe('/a/%20b.png')
  expect(droppedImagePath('file:///a/100%.png')).toBeNull()
})

test('dropped path: ignores text that is not an image file', () => {
  expect(droppedImagePath('hello')).toBeNull()
  expect(droppedImagePath('/a/notes.txt')).toBeNull()
  expect(droppedImagePath('relative/pic.png')).toBeNull()
})

test('open tries mac, linux, then windows', () => {
  expect(openArgv('/a/1.png').map(a => a.argv[0])).toEqual(['open', 'xdg-open', 'cmd'])
})

test('reveal falls back to explorer, then the folder on linux', () => {
  const r = revealArgv('/a/b/1.png')
  expect(r[1].argv).toEqual(['explorer', '/select,/a/b/1.png'])
  expect(r[2].argv).toEqual(['xdg-open', '/a/b'])
})
