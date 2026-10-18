export const tokens = (text: string) =>
  [...text.matchAll(/\[Image #?(\d+)\]/g)].map(m => Number(m[1]))

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i

// The absolute path of a dropped or pasted image file (plain, quoted, escaped
// or file://), or null for anything else, including a URL that won't decode.
export function droppedImagePath(input: string): string | null {
  let raw = input.trim().replace(/^(['"])(.*)\1$/, '$2')
  if (raw.startsWith('file://')) {
    try {
      raw = decodeURIComponent(raw.slice('file://'.length))
    } catch {
      return null
    }
  } else {
    raw = raw.replace(/\\(.)/g, '$1')
  }
  return raw.startsWith('/') && raw.length > 1 && IMAGE_EXT.test(raw) ? raw : null
}
