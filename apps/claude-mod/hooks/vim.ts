import { applyKey, backspace, move, remove } from './edit-buffer'
import type { Buffer, Key } from './edit-buffer'

// Vim's keys over the editor's buffer: a normal mode that moves and cuts, an
// insert mode that types. A subset, the part the hands know: motions, the
// line register, `u`. No engine and no surface here: keys in, buffer out.
//
// Escape never reaches a surface module (it hands the keys back to the
// prompt), so insert mode is left with `jk`, as many a vimrc maps it.

export type Mode = 'normal' | 'insert'

/**
 * What Vim holds between keys: the mode, the first key of a two-key command
 * (`g`, `d`, `y`, or in insert mode the `j` that `k` may follow), and the
 * lines last cut or copied.
 */
export type Vim = { mode: Mode; pending: string; register: readonly string[] }

export const VIM_START: Vim = { mode: 'normal', pending: '', register: [] }

/** What a key came to: the buffer and Vim's state after it, and what the editor is asked to do besides. */
export type VimStep = { buffer: Buffer; vim: Vim; ask?: 'undo' }

const lineOf = (buffer: Buffer): string => buffer.lines[buffer.row] ?? ''

const at = (buffer: Buffer, row: number, col: number): Buffer => {
  const line = Math.max(0, Math.min(row, buffer.lines.length - 1))

  return { lines: buffer.lines, row: line, col: Math.max(0, Math.min(col, (buffer.lines[line] ?? '').length)) }
}

/** The first column of a line that is not a blank. */
const indentOf = (line: string): number => /^[ \t]*/.exec(line)?.[0].length ?? 0

const kindOf = (char: string | undefined): 'blank' | 'word' | 'mark' =>
  char === undefined || /\s/.test(char) ? 'blank' : /[A-Za-z0-9_]/.test(char) ? 'word' : 'mark'

/** One line of the buffer replaced, the cursor left where it is told. */
const withLine = (buffer: Buffer, text: string, col: number): Buffer => {
  const lines = [...buffer.lines]
  lines[buffer.row] = text

  return { lines, row: buffer.row, col }
}

/** `w`: the start of the next word, on a later line when this one has no more. */
function wordOn(buffer: Buffer): Buffer {
  const line = lineOf(buffer)
  let col = buffer.col
  const from = kindOf(line[col])
  while (col < line.length && from !== 'blank' && kindOf(line[col]) === from) col += 1
  while (col < line.length && kindOf(line[col]) === 'blank') col += 1
  if (col < line.length || buffer.row >= buffer.lines.length - 1) return at(buffer, buffer.row, col)

  return at(buffer, buffer.row + 1, indentOf(buffer.lines[buffer.row + 1] ?? ''))
}

/** `b`: the start of this word, or of the one before it. */
function wordBack(buffer: Buffer): Buffer {
  const line = lineOf(buffer)
  let col = buffer.col
  if (col === 0) return buffer.row === 0 ? buffer : at(buffer, buffer.row - 1, Number.MAX_SAFE_INTEGER)
  col -= 1
  while (col > 0 && kindOf(line[col]) === 'blank') col -= 1
  const kind = kindOf(line[col])
  while (col > 0 && kindOf(line[col - 1]) === kind) col -= 1

  return at(buffer, buffer.row, col)
}

/** `e`: the end of this word, or of the next. */
function wordEnd(buffer: Buffer): Buffer {
  const line = lineOf(buffer)
  let col = buffer.col + 1
  while (col < line.length && kindOf(line[col]) === 'blank') col += 1
  if (col >= line.length) return wordOn(buffer)
  const kind = kindOf(line[col])
  while (col + 1 < line.length && kindOf(line[col + 1]) === kind) col += 1

  return at(buffer, buffer.row, col)
}

/** `count` lines from `from` taken out; a buffer always keeps one line, an empty one when all are cut. */
function cutLines(buffer: Buffer, from: number, count: number): Buffer {
  const lines = [...buffer.lines]
  lines.splice(from, count)
  if (lines.length === 0) lines.push('')
  const row = Math.min(from, lines.length - 1)

  return { lines, row, col: indentOf(lines[row] ?? '') }
}

/** Lines put in at `row`, the cursor on the first of them. */
function putLines(buffer: Buffer, row: number, added: readonly string[], col = indentOf(added[0] ?? '')): Buffer {
  const lines = [...buffer.lines]
  lines.splice(row, 0, ...added)

  return { lines, row, col }
}

function normal(buffer: Buffer, vim: Vim, key: Key, page: number): VimStep | undefined {
  const still = (next: Buffer, more: Partial<Vim> = {}): VimStep => ({ buffer: next, vim: { ...vim, pending: '', ...more } })
  const typing = (next: Buffer): VimStep => still(next, { mode: 'insert' })
  const whole = Math.max(1, page - 1)
  if (key.meta === true) return undefined
  if (key.ctrl === true) {
    if (key.key === 'd') return still(move(buffer, 'down', Math.max(1, Math.floor(page / 2))))
    if (key.key === 'u') return still(move(buffer, 'up', Math.max(1, Math.floor(page / 2))))
    if (key.key === 'f') return still(move(buffer, 'down', whole))
    if (key.key === 'b') return still(move(buffer, 'up', whole))

    return undefined
  }
  const line = lineOf(buffer)

  // The second key of a two-key command; any other key lets the first one go.
  if (vim.pending === 'g') return still(key.key === 'g' ? at(buffer, 0, 0) : buffer)
  if (vim.pending === 'y') return still(buffer, key.key === 'y' ? { register: [line] } : {})
  if (vim.pending === 'd') {
    if (key.key === 'd') return still(cutLines(buffer, buffer.row, 1), { register: [line] })
    if (key.key !== 'w') return still(buffer)
    const to = wordOn(buffer)

    return still(withLine(buffer, line.slice(0, buffer.col) + line.slice(to.row === buffer.row ? to.col : line.length), buffer.col))
  }

  switch (key.key) {
    case 'h':
    case 'left':
    case 'backspace':
      return still(at(buffer, buffer.row, buffer.col - 1))
    case 'l':
    case 'right':
    case 'space':
      return still(at(buffer, buffer.row, buffer.col + 1))
    case 'j':
    case 'down':
    case 'return':
    case 'enter':
      return still(move(buffer, 'down'))
    case 'k':
    case 'up':
      return still(move(buffer, 'up'))
    case 'w':
      return still(wordOn(buffer))
    case 'b':
      return still(wordBack(buffer))
    case 'e':
      return still(wordEnd(buffer))
    case '0':
    case 'home':
      return still(at(buffer, buffer.row, 0))
    case '^':
      return still(at(buffer, buffer.row, indentOf(line)))
    case '$':
    case 'end':
      return still(at(buffer, buffer.row, line.length))
    case 'G':
      return still(at(buffer, buffer.lines.length - 1, 0))
    case 'pageup':
      return still(move(buffer, 'up', whole))
    case 'pagedown':
      return still(move(buffer, 'down', whole))
    case 'g':
    case 'd':
    case 'y':
      return { buffer, vim: { ...vim, pending: key.key } }
    case 'x':
    case 'delete':
      return still(buffer.col < line.length ? remove(buffer) : buffer)
    case 'D':
      return still(withLine(buffer, line.slice(0, buffer.col), buffer.col))
    case 'J': {
      const below = buffer.lines[buffer.row + 1]
      if (below === undefined) return still(buffer)
      const lines = [...buffer.lines]
      lines.splice(buffer.row, 2, `${line.trimEnd()} ${below.trimStart()}`)

      return still({ lines, row: buffer.row, col: line.trimEnd().length })
    }
    case 'p':
      return still(vim.register.length === 0 ? buffer : putLines(buffer, buffer.row + 1, vim.register))
    case 'P':
      return still(vim.register.length === 0 ? buffer : putLines(buffer, buffer.row, vim.register))
    case 'u':
      return { buffer, vim: { ...vim, pending: '' }, ask: 'undo' }
    case 'i':
      return typing(buffer)
    case 'a':
      return typing(at(buffer, buffer.row, buffer.col + 1))
    case 'I':
      return typing(at(buffer, buffer.row, indentOf(line)))
    case 'A':
      return typing(at(buffer, buffer.row, line.length))
    case 'o':
      return typing(putLines(buffer, buffer.row + 1, [' '.repeat(indentOf(line))], indentOf(line)))
    case 'O':
      return typing(putLines(buffer, buffer.row, [' '.repeat(indentOf(line))], indentOf(line)))
    default:
      // Any other key means nothing in normal mode, and is never typed into the text.
      return still(buffer)
  }
}

/**
 * What a key does under Vim; `undefined` for a chord the editor reads itself
 * (ctrl+s) or a key with no meaning. In insert mode a `k` straight after a
 * `j` takes that `j` back out and returns to normal mode.
 */
export function vimKey(buffer: Buffer, vim: Vim, key: Key, page: number): VimStep | undefined {
  if (vim.mode === 'normal') return normal(buffer, vim, key, page)
  const isPlain = key.ctrl !== true && key.meta !== true
  if (isPlain && key.key === 'k' && vim.pending === 'j' && lineOf(buffer)[buffer.col - 1] === 'j') {
    return { buffer: backspace(buffer), vim: { ...vim, mode: 'normal', pending: '' } }
  }
  const typed = applyKey(buffer, key, page)
  if (typed === undefined) return undefined

  return { buffer: typed, vim: { ...vim, pending: isPlain && key.key === 'j' ? 'j' : '' } }
}
