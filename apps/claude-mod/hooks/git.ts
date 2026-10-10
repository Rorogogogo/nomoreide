import type { Commit, Diff, GitFile, Pull, PullItem, Repo } from '../types'

// Reading git, with no engine in sight: the hooks module runs the commands
// and hands their output here.

/** The diff lines one pane holds before the rest is counted, not drawn. */
const MAX_DIFF_LINES = 400
const MAX_LINE_CHARS = 400

export const isStaged = (file: GitFile): boolean =>
  file.index !== ' ' && file.index !== '?'

export const isChanged = (file: GitFile): boolean => file.workingTree !== ' '

/** `git status --porcelain=v1 --branch -z`, read. */
export function parseStatus(
  raw: string,
): Pick<Repo, 'branch' | 'upstream' | 'ahead' | 'behind' | 'files'> {
  const entries = raw.split('\0')
  const files: GitFile[] = []
  let branch = ''
  let upstream = ''
  let ahead = 0
  let behind = 0

  for (let at = 0; at < entries.length; at += 1) {
    const entry = entries[at]
    if (entry === undefined || entry === '') continue

    if (entry.startsWith('## ')) {
      const head = entry.slice(3)
      const tracking = /^(.+?)\.\.\.(\S+)(?: \[(.+)\])?$/.exec(head)
      if (tracking === null) {
        branch =
          head === 'HEAD (no branch)'
            ? 'detached'
            : head.replace(/^No commits yet on /, '')
      } else {
        branch = tracking[1] ?? ''
        upstream = tracking[2] ?? ''
        ahead = Number(/ahead (\d+)/.exec(tracking[3] ?? '')?.[1] ?? 0)
        behind = Number(/behind (\d+)/.exec(tracking[3] ?? '')?.[1] ?? 0)
      }
      continue
    }

    const index = entry[0] ?? ' '
    const workingTree = entry[1] ?? ' '
    files.push({ path: entry.slice(3), index, workingTree })
    // A rename or a copy is followed by the path it came from.
    if ('RC'.includes(index) || 'RC'.includes(workingTree)) at += 1
  }

  return { branch, upstream, ahead, behind, files }
}

/**
 * The `git` arguments that show one file's diff, or `undefined` where there
 * is none to ask for.
 *
 * Nothing in the index stands against an untracked file, so it is shown
 * against an empty one; a folder of them has no single diff.
 */
export function diffArgs(file: GitFile, staged: boolean): string[] | undefined {
  if (!staged && file.index === '?') {
    return file.path.endsWith('/')
      ? undefined
      : ['diff', '--no-color', '--no-index', '--', '/dev/null', file.path]
  }

  return [
    'diff',
    '--no-color',
    '--no-ext-diff',
    ...(staged ? ['--cached'] : []),
    '--',
    file.path,
  ]
}

/**
 * A diff as `Code` draws one: the hunks alone, within `max` lines.
 *
 * A diff cut mid-hunk does not parse, so the hunk the cut falls in has its
 * header's counts rewritten to the lines that are left.
 */
export function fitHunks(
  raw: string,
  max = MAX_DIFF_LINES,
): Pick<Diff, 'hunks' | 'hiddenLines'> {
  const lines = raw.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const first = lines.findIndex(line => line.startsWith('@@'))
  if (first < 0) return { hunks: '', hiddenLines: 0 }

  const body = lines.slice(first)
  const kept = body
    .slice(0, max)
    .map(line =>
      line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line,
    )
  if (body.length > max) {
    let head = kept.length - 1
    while (head > 0 && !(kept[head] ?? '').startsWith('@@')) head -= 1
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(
      kept[head] ?? '',
    )
    const rest = kept.slice(head + 1)
    if (header === null || rest.length === 0) {
      kept.length = head
    } else {
      const before = rest.filter(line => /^[ -]/.test(line)).length
      const after = rest.filter(line => /^[ +]/.test(line)).length
      kept[head] =
        `@@ -${header[1]},${before} +${header[2]},${after} @@${header[3]}`
    }
  }

  return { hunks: kept.join('\n'), hiddenLines: body.length - kept.length }
}

/** The last lines of what a command printed: why it failed, without the scroll. */
export const tail = (text: string, lines = 8): string =>
  text.trim().split('\n').slice(-lines).join('\n')

const FAILED = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']
const PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED']

/**
 * `gh pr view --json number,title,url,state,isDraft,statusCheckRollup` for a
 * branch, read; `null` for anything that is not a pull request. A check run
 * says `status` and `conclusion`, a commit status says `state`.
 */
export function parsePull(root: string, json: string): Pull | null {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const pull = value as Record<string, unknown>
  if (typeof pull.number !== 'number' || typeof pull.url !== 'string') return null
  const checks = (Array.isArray(pull.statusCheckRollup) ? pull.statusCheckRollup : []).map(one => {
    const check = (typeof one === 'object' && one !== null ? one : {}) as Record<string, unknown>
    const result = String(check.conclusion || check.state || '').toUpperCase()
    if (FAILED.includes(result)) return 'failed'

    return PASSED.includes(result) ? 'passed' : 'running'
  })
  const passed = checks.filter(one => one === 'passed').length

  return {
    root,
    number: pull.number,
    title: typeof pull.title === 'string' ? pull.title : '',
    url: /^https:\/\//.test(pull.url) ? pull.url : '',
    state: typeof pull.state === 'string' ? pull.state : 'OPEN',
    isDraft: pull.isDraft === true,
    checks:
      checks.length === 0
        ? 'none'
        : checks.includes('failed')
          ? 'failing'
          : passed === checks.length
            ? 'passing'
            : 'running',
    passed,
    total: checks.length,
  }
}

export type DiffRow = {
  kind: 'hunk' | 'added' | 'removed' | 'same'
  /** The line's number in the file as it was, and as it is; `null` on the side it is not on. */
  before: number | null
  after: number | null
  text: string
}

/** Unified-diff hunks as rows, each with its line number on either side. */
export function diffRows(hunks: string): DiffRow[] {
  let before = 0
  let after = 0

  return hunks.split('\n').flatMap((line): DiffRow[] => {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (header !== null) {
      before = Number(header[1])
      after = Number(header[2])

      return [{ kind: 'hunk', before: null, after: null, text: (header[3] ?? '').trim() }]
    }
    if (line.startsWith('\\')) return []
    const text = line.slice(1)
    if (line.startsWith('+')) return [{ kind: 'added', before: null, after: after++, text }]
    if (line.startsWith('-')) return [{ kind: 'removed', before: before++, after: null, text }]

    return [{ kind: 'same', before: before++, after: after++, text }]
  })
}

/** How many lines of the graph one look takes. */
export const LOG_LINES = 80

/** `git log` as a graph of every branch, each commit's fields set apart by a unit separator. */
export const LOG_ARGS = [
  'log',
  '--graph',
  '--all',
  '--date-order',
  `-n${LOG_LINES}`,
  '--format=%x1f%h%x1f%s%x1f%an%x1f%ct%x1f%D',
] as const

/** `git log --graph` read line by line: the graph's characters and, on a commit's line, the commit. */
export function parseLog(out: string): Commit[] {
  return out
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      const [graph = '', sha = '', subject = '', author = '', seconds = '', refs = ''] = line.split('\x1f')

      return {
        graph: graph.replace(/\s+$/, ''),
        sha,
        subject,
        author,
        at: (Number(seconds) || 0) * 1000,
        refs: refs
          .split(', ')
          .map(ref => ref.replace(/^HEAD -> /, '').replace(/^tag: /, '').trim())
          .filter(ref => ref !== '' && ref !== 'HEAD' && !ref.endsWith('/HEAD')),
      }
    })
}

/** One commit's own fields, asked for with `COMMIT_FORMAT`; `undefined` when git named none. */
export const COMMIT_FORMAT = '--format=%h%x1f%s%x1f%an%x1f%ct%x1f%b'

export function parseCommit(out: string): { sha: string; subject: string; author: string; at: number; body: string } | undefined {
  const [sha = '', subject = '', author = '', seconds = '', body = ''] = out.split('\x1f')
  if (sha.trim() === '') return undefined

  return { sha: sha.trim(), subject, author, at: (Number(seconds) || 0) * 1000, body: body.trim() }
}

/** `git show --name-status`: each file a commit touched and how. A rename is told by its new path. */
export function parseNameStatus(out: string): { status: string; path: string }[] {
  return out
    .split('\n')
    .map(line => line.split('\t'))
    .filter(parts => parts.length >= 2 && /^[A-Z]/.test(parts[0] ?? ''))
    .map(parts => ({ status: (parts[0] ?? 'M').charAt(0), path: parts[parts.length - 1] ?? '' }))
    .filter(one => one.path !== '')
}

/** What `gh pr list` is asked for. */
export const PULL_LIST_FIELDS = 'number,title,url,state,isDraft,statusCheckRollup,headRefName,author,updatedAt'

/** `gh pr list --json ...` read: each pull request as `parsePull` reads one, and whose it is. */
export function parsePulls(root: string, json: string): PullItem[] {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []

  return value.flatMap(one => {
    const pull = parsePull(root, JSON.stringify(one))
    if (pull === null) return []
    const row = one as Record<string, unknown>
    const author = typeof row.author === 'object' && row.author !== null ? (row.author as { login?: unknown }).login : undefined

    return [
      {
        ...pull,
        branch: typeof row.headRefName === 'string' ? row.headRefName : '',
        author: typeof author === 'string' ? author : '',
        updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
      },
    ]
  })
}
