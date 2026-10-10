import type { Entry, Hit, OpenFile, Repo } from '../types'

// A file as the pane holds one: read whole, shown a window at a time, and
// changed a line at a time, since a pane's text field is one line.

/** Past this a file is named and not read: the pane is no place for it. */
export const MAX_FILE_BYTES = 300_000
/** Lines in view at once: a highlighted read, and the shorter run of pressable lines. */
export const VIEW_LINES = 120
export const EDIT_LINES = 40
/** Past this the whole text does not fit what the editor is handed, and a file is changed a line at a time. */
export const MAX_EDITOR_CHARS = 90_000

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
  return { path, text, note, mtimeMs, top: 0, isEditing: false, line: null, isDirty: false }
}

/** How many names, and how many lines, one search shows. */
export const MAX_FOUND = 60

const SKIPPED = /(^|\/)(node_modules|\.git|dist|target|out)\//

/** Paths whose name holds `query`, any case: a match in the file's own name first, then in its folders. */
export function matchNames(paths: readonly string[], query: string): string[] {
  const wanted = query.toLowerCase()
  const kept = paths.filter(path => path !== '' && !SKIPPED.test(path) && path.toLowerCase().includes(wanted))
  const inName = (path: string): boolean => path.slice(path.lastIndexOf('/') + 1).toLowerCase().includes(wanted)

  return kept.sort((a, b) => Number(inName(b)) - Number(inName(a)) || a.length - b.length || a.localeCompare(b))
}

/** `grep -n` output (`path:line:text`), read; `prefix` is put before each path. */
export function parseGrep(out: string, prefix = ''): Hit[] {
  return out.split('\n').flatMap(row => {
    const found = /^(.+?):(\d+):(.*)$/.exec(row)
    if (found === null) return []
    const path = `${prefix}${(found[1] ?? '').replace(/^\.\//, '')}`

    return SKIPPED.test(path) ? [] : [{ path, line: Number(found[2]), text: (found[3] ?? '').trim().slice(0, 200) }]
  })
}

/**
 * A file's git letter, as the Changes list shows it (`M`, `A`, `D`, `?`), by
 * its absolute path; `''` for one with nothing to say. What the working tree
 * holds comes before what is staged.
 */
export function statusOf(repos: readonly Repo[], path: string): string {
  for (const repo of repos) {
    if (!path.startsWith(`${repo.root}/`)) continue
    const within = path.slice(repo.root.length + 1)
    const file = repo.files.find(one => one.path === within)
    if (file !== undefined) return file.workingTree !== ' ' ? file.workingTree : file.index
  }

  return ''
}

/** Whether a folder holds anything git has to say: a changed file below it, or the folder itself untracked. */
export function holdsChanges(repos: readonly Repo[], folder: string): boolean {
  return repos.some(repo =>
    repo.files.some(file => {
      const path = `${repo.root}/${file.path.replace(/\/$/, '')}`

      return path === folder || path.startsWith(`${folder}/`) || folder.startsWith(`${path}/`)
    }),
  )
}

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')

  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Where the first two letters of an extension would read as another one's.
const TAGS: Readonly<Record<string, string>> = {
  json: '{}',
  jsonc: '{}',
  tsx: 'tx',
  jsx: 'jx',
  toml: 'tm',
  yaml: 'ym',
  yml: 'ym',
  html: 'ht',
  lock: 'lk',
  svg: 'sv',
}

/** A file's kind in two characters, from its extension: `ts`, `rs`, `md`; `··` for one without. */
export function tagOf(name: string): string {
  const extension = extensionOf(name)

  return extension === '' ? '··' : (TAGS[extension] ?? extension.slice(0, 2).padEnd(2))
}

/** The families a file's tag is coloured by: few enough to learn, none of them a status colour. */
export type Family = 'script' | 'typed' | 'systems' | 'python' | 'prose' | 'data' | 'style' | 'image' | 'shell' | 'other'

const FAMILIES: Readonly<Record<Exclude<Family, 'other'>, readonly string[]>> = {
  typed: ['ts', 'tsx', 'mts', 'cts'],
  script: ['js', 'jsx', 'mjs', 'cjs'],
  systems: ['rs', 'go', 'c', 'h', 'cpp', 'cc', 'hpp', 'swift', 'java', 'kt', 'cs', 'zig'],
  python: ['py', 'rb', 'php', 'lua', 'ex', 'exs'],
  prose: ['md', 'mdx', 'txt', 'rst', 'adoc'],
  data: ['json', 'jsonc', 'toml', 'yaml', 'yml', 'xml', 'csv', 'sql', 'lock', 'env'],
  style: ['css', 'scss', 'sass', 'less', 'html', 'vue', 'svelte', 'astro'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'pdf', 'mp4', 'mov'],
  shell: ['sh', 'bash', 'zsh', 'fish', 'ps1'],
}

export function familyOf(name: string): Family {
  const extension = extensionOf(name)
  for (const [family, extensions] of Object.entries(FAMILIES)) {
    if (extensions.includes(extension)) return family as Family
  }

  return 'other'
}
