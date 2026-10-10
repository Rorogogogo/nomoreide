/** Cuts `text` to `max` cells, the ellipsis at the end. */
export function clipEnd(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text

  return max === 1 ? '…' : `${text.slice(0, max - 1)}…`
}

/** Cuts `text` to `max` cells, keeping its tail: the near end of a path. */
export function clipStart(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text

  return max === 1 ? '…' : `…${text.slice(text.length - max + 1)}`
}

/** A path as a row reads it: the name first, where it lives after. */
export function splitPath(path: string): { name: string; dir: string } {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const cut = trimmed.lastIndexOf('/')

  return cut < 0
    ? { name: path, dir: '' }
    : { name: path.slice(cut + 1), dir: path.slice(0, cut) }
}

/** How long ago an ISO timestamp was, in the one unit that fits: `2m`, `3h`. */
export function age(now: number, iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`

  return `${Math.round(hours / 24)}d`
}

export function tilde(path: string, home: string): string {
  if (home === '') return path
  if (path === home) return '~'

  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

export const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`

/** A colour as `#rrggbb`, or `''` for anything a tree would be refused over. */
export function hexOf(value: string): string {
  const hex = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(value.trim())?.[1]
  if (hex === undefined) return ''

  return `#${hex.length === 3 ? [...hex].map(one => one + one).join('') : hex}`.toLowerCase()
}
