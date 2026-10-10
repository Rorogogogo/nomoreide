import type { Entry, OpenFile } from '../types'

// A file as the pane holds one: read whole, shown a window at a time, and
// changed a line at a time, since a pane's text field is one line.

/** Past this a file is named and not read: the pane is no place for it. */
export const MAX_FILE_BYTES = 300_000
/** Lines in view at once: a highlighted read, and the shorter run of pressable lines. */
export const VIEW_LINES = 120
export const EDIT_LINES = 40

/** Folders first, then files, each by name; `.git` is left out. */
export function sortEntries(entries: readonly Entry[]): Entry[] {
  return entries
    .filter(one => one.name !== '.git' && one.name !== '.DS_Store')
    .map(one => ({ name: one.name, kind: one.kind }))
    .sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name))
}

/** Whether `path` is `folder` or inside it: what keeps the pane to the session's own folder. */
export const isUnder = (path: string, folder: string): boolean =>
  folder !== '' && !path.split('/').includes('..') && (path === folder || path.startsWith(`${folder}/`))

/** A file's lines, the final newline not counted as a line of its own. */
export function linesOf(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()

  return lines
}

const eol = (line: string): string => (line.endsWith('\r') ? '\r' : '')

/** A line as a text field shows it: without the carriage return a CRLF file ends it with. */
export const shownLine = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line)

export type Edit =
  | { kind: 'replace'; line: number; value: string }
  | { kind: 'insert'; line: number }
  | { kind: 'delete'; line: number }

/**
 * `text` with one line changed, the file's own line endings and final
 * newline kept; `undefined` when the line is not there to change. `insert`
 * puts an empty line after `line` (0 puts it first).
 */
export function applyEdit(text: string, edit: Edit): string | undefined {
  const endsWithNewline = text.endsWith('\n')
  const lines = linesOf(text)
  const at = edit.line - 1
  if (edit.kind === 'insert') {
    if (edit.line < 0 || edit.line > lines.length) return undefined
    lines.splice(edit.line, 0, eol(lines[Math.max(0, at)] ?? ''))
  } else {
    const held = lines[at]
    if (held === undefined) return undefined
    // A text field is one line: a pasted line break would split this one in two unseen.
    if (edit.kind === 'replace') lines[at] = edit.value.replace(/[\r\n]+/g, ' ') + eol(held)
    else lines.splice(at, 1)
  }

  return lines.join('\n') + (endsWithNewline ? '\n' : '')
}

/** Where a window of `size` lines starts so that it holds `line` (from 1) and stays inside the file. */
export function windowFor(line: number, size: number, total: number): number {
  const top = Math.floor((line - 1) / size) * size

  return Math.max(0, Math.min(top, Math.max(0, total - 1)))
}

/** The file as first opened: at its top, being read. */
export function opened(path: string, text: string, note: string, mtimeMs: number): OpenFile {
  return { path, text, note, mtimeMs, top: 0, isEditing: false, line: null }
}
