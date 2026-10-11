// A text buffer as an editor keeps one: lines, and a cursor between two
// characters of one of them. Every change is a new buffer, so the one before
// can be gone back to. No engine and no surface here: keys in, buffer out.

export type Buffer = { lines: string[]; row: number; col: number }

/** A key as a surface hands one: a special key's name or the character typed. */
export type Key = { key: string; ctrl?: true; shift?: true; meta?: true }

export function bufferOf(text: string, row = 0, col = 0): Buffer {
  const lines = text.split('\n')
  const at = Math.max(0, Math.min(row, lines.length - 1))

  return { lines, row: at, col: Math.max(0, Math.min(col, (lines[at] ?? '').length)) }
}

export const textOf = (buffer: Buffer): string => buffer.lines.join('\n')

const lineOf = (buffer: Buffer): string => buffer.lines[buffer.row] ?? ''

const withLines = (buffer: Buffer, from: number, removed: number, added: string[], row: number, col: number): Buffer => {
  const lines = [...buffer.lines]
  lines.splice(from, removed, ...added)

  return { lines, row, col }
}

/** `text` put in at the cursor; a line break in it starts a new line. */
export function insert(buffer: Buffer, text: string): Buffer {
  const line = lineOf(buffer)
  const parts = (line.slice(0, buffer.col) + text + line.slice(buffer.col)).split('\n')
  const added = text.split('\n')
  const lastAdded = added.at(-1) ?? ''

  return withLines(
    buffer,
    buffer.row,
    1,
    parts,
    buffer.row + added.length - 1,
    added.length === 1 ? buffer.col + text.length : lastAdded.length,
  )
}

/** A new line at the cursor, starting as far in as the line it is broken from. */
export function newline(buffer: Buffer): Buffer {
  const indent = /^[ \t]*/.exec(lineOf(buffer))?.[0] ?? ''

  return insert(buffer, `\n${indent.slice(0, buffer.col)}`)
}

/** The character before the cursor taken out; at a line's start, the line joined to the one above. */
export function backspace(buffer: Buffer): Buffer {
  const line = lineOf(buffer)
  if (buffer.col > 0) {
    return withLines(buffer, buffer.row, 1, [line.slice(0, buffer.col - 1) + line.slice(buffer.col)], buffer.row, buffer.col - 1)
  }
  if (buffer.row === 0) return buffer
  const above = buffer.lines[buffer.row - 1] ?? ''

  return withLines(buffer, buffer.row - 1, 2, [above + line], buffer.row - 1, above.length)
}

/** The character at the cursor taken out; at a line's end, the line below joined to it. */
export function remove(buffer: Buffer): Buffer {
  const line = lineOf(buffer)
  if (buffer.col < line.length) {
    return withLines(buffer, buffer.row, 1, [line.slice(0, buffer.col) + line.slice(buffer.col + 1)], buffer.row, buffer.col)
  }
  const below = buffer.lines[buffer.row + 1]

  return below === undefined ? buffer : withLines(buffer, buffer.row, 2, [line + below], buffer.row, buffer.col)
}

/** The cursor moved, kept inside the text; left and right cross a line's end. */
export function move(buffer: Buffer, to: 'up' | 'down' | 'left' | 'right' | 'home' | 'end', by = 1): Buffer {
  const { lines, row, col } = buffer
  const clamp = (line: number, column: number): Buffer => {
    const at = Math.max(0, Math.min(line, lines.length - 1))

    return { lines, row: at, col: Math.max(0, Math.min(column, (lines[at] ?? '').length)) }
  }
  if (to === 'up') return clamp(row - by, col)
  if (to === 'down') return clamp(row + by, col)
  if (to === 'home') return clamp(row, 0)
  if (to === 'end') return clamp(row, lineOf(buffer).length)
  if (to === 'left') return col > 0 ? clamp(row, col - 1) : row > 0 ? clamp(row - 1, Number.MAX_SAFE_INTEGER) : buffer

  return col < lineOf(buffer).length ? clamp(row, col + 1) : row < lines.length - 1 ? clamp(row + 1, 0) : buffer
}

const NAMED = ['up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'return', 'enter', 'backspace', 'delete', 'tab', 'space', 'escape']

/**
 * What a key does to a buffer, a page being `page` lines; `undefined` for a
 * key that is not an edit or a move (a chord the editor reads itself, a key
 * with no meaning here).
 */
export function applyKey(buffer: Buffer, key: Key, page: number): Buffer | undefined {
  if (key.ctrl === true || key.meta === true) return undefined
  switch (key.key) {
    case 'up':
    case 'down':
    case 'left':
    case 'right':
    case 'home':
    case 'end':
      return move(buffer, key.key)
    case 'pageup':
      return move(buffer, 'up', Math.max(1, page - 1))
    case 'pagedown':
      return move(buffer, 'down', Math.max(1, page - 1))
    case 'return':
    case 'enter':
      return newline(buffer)
    case 'backspace':
      return backspace(buffer)
    case 'delete':
      return remove(buffer)
    case 'tab':
      return insert(buffer, '  ')
    case 'space':
      return insert(buffer, ' ')
    default:
      // The character typed, or a run of them pasted; never a control character.
      return NAMED.includes(key.key) || key.key === '' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(key.key)
        ? undefined
        : insert(buffer, key.key.replace(/\r\n?/g, '\n').replace(/\t/g, '  '))
  }
}

/** Where a window of `size` starts so that `at` is inside it, moved no more than it must be. */
export function scrolled(start: number, at: number, size: number): number {
  if (at < start) return at

  return at >= start + size ? at - size + 1 : start
}
