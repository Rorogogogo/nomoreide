import type { Diff, GitFile, Pull, Repo } from '../types'

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
