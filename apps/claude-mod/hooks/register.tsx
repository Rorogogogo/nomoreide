import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type {
  Activity,
  DbRows,
  DbTables,
  Diff,
  GitSection,
  Listing,
  OpenFile,
  Runs,
  GitFile,
  Incident,
  LogLine,
  Notice,
  Pull,
  Repo,
  Section,
  Service,
  ServiceSection,
  Snapshots,
  Tab,
  Task,
  Tasks,
  Tools,
  Usage,
} from '../types'
import {
  EMPTY_TASKS,
  OFFLINE,
  endpointOf,
  replyOf,
  restoredOf,
  toActivePath,
  toActivity,
  toChangeFiles,
  toChangeSets,
  toDatabases,
  toDbRows,
  toFixPrompt,
  toIncidents,
  toLinearScope,
  toLogs,
  toServices,
  toSnapshots,
  toTableNames,
  toTaskPrompt,
  toTasks,
  toTools,
  toUsage,
} from './daemon'
import type { Endpoint, Reply } from './daemon'
import { EDIT_LINES, MAX_FILE_BYTES, VIEW_LINES, applyEdit, isUnder, linesOf, opened, sortEntries, windowFor } from './files'
import type { Edit } from './files'
import { isEcho, isFocusOnlyClick } from './focus'
import { diffArgs, fitHunks, isChanged, isStaged, parsePull, parseStatus, tail } from './git'
import { RUN_FIELDS, parseJobs, parseRuns, toRunPrompt } from './github'
import { hexOf } from './text'
import { palette } from './tokens'
import type { Actions, Kit, Model, ServiceVerb } from './views/model'
import { band, pane } from './views/pane'

type Engine = EngineInterface

// This file is long by the repo's measure, and has to be: the engine follows
// `$` into functions declared in the hooks module itself and never across an
// import, and `read`/`update` must name an atom declared here. So every call
// on the engine lives in this file; what needs no engine is in `git.ts`,
// `daemon.ts`, `focus.ts` and `views/`.

const PANE = 'nomoreide'
const TITLE = 'NoMoreIDE'
/** Wide enough for a diff to read, narrow enough to leave the transcript 80. */
const COLUMNS = 68
const GIT_EVERY_MS = 3_000
const DAEMON_EVERY_MS = 5_000
/** Git polls between two looks for which repositories the folder holds. */
const ROOTS_EVERY = 10
const TAB_IDS: readonly Tab[] = ['git', 'errors', 'services', 'console', 'linear']
const SECTION_IDS: readonly Section[] = ['changes', 'usage', 'tools']
const SERVICE_SECTION_IDS: readonly ServiceSection[] = ['services', 'activity', 'database']
/** Rows of a table read at a time. */
const DB_PAGE = 20
const GIT_SECTION_IDS: readonly GitSection[] = ['changes', 'files', 'actions']
/** How many of a branch's workflow runs are listed. */
const MAX_RUNS = 15
/** What is asked of GitHub, of Linear, and of the daemon's heavier reads, no oftener than this. */
const SLOW_EVERY_MS = 60_000
/** How far back the Usage view's history goes. */
const USAGE_DAYS = 30
/** Pages of thirty a team's issues are read to, looking for the open ones. */
const TASK_PAGES = 3
/** The label a checkpoint taken from the pane carries. */
const SNAPSHOT_LABEL = 'from Claude Code'
/** How many repositories a folder of them shows; the rest are left out. */
const MAX_REPOS = 8

// Everything the pane and the band draw from. The host keeps these for the
// session, so a hot reload redraws where the person was.
const tab = atom({ plugin: 'nomoreide', key: 'tab' } as const, 'git')
const isActive = atom({ plugin: 'nomoreide', key: 'isActive' } as const, false)
const isLight = atom({ plugin: 'nomoreide', key: 'isLight' } as const, false)
const scheme = atom({ plugin: 'nomoreide', key: 'scheme' } as const, 'auto')
const fill = atom({ plugin: 'nomoreide', key: 'fill' } as const, '')
const reach = atom({ plugin: 'nomoreide', key: 'reach' } as const, 'unknown')
const counts = atom({ plugin: 'nomoreide', key: 'counts' } as const, {
  changed: 0,
  errors: 0,
  live: 0,
  failed: 0,
  tasks: 0,
})
const workspace = atom({ plugin: 'nomoreide', key: 'workspace' } as const, '')
const repos = atom({ plugin: 'nomoreide', key: 'repos' } as const, [])
const repo = atom({ plugin: 'nomoreide', key: 'repo' } as const, '')
const diff = atom({ plugin: 'nomoreide', key: 'diff' } as const, null)
const notice = atom({ plugin: 'nomoreide', key: 'notice' } as const, null)
const services = atom({ plugin: 'nomoreide', key: 'services' } as const, [])
const showsElsewhere = atom({ plugin: 'nomoreide', key: 'showsElsewhere' } as const, false)
const logs = atom({ plugin: 'nomoreide', key: 'logs' } as const, null)
const incidents = atom({ plugin: 'nomoreide', key: 'incidents' } as const, [])
const incident = atom({ plugin: 'nomoreide', key: 'incident' } as const, null)
const pulls = atom({ plugin: 'nomoreide', key: 'pulls' } as const, [])
const snapshots = atom({ plugin: 'nomoreide', key: 'snapshots' } as const, null)
const serviceSection = atom({ plugin: 'nomoreide', key: 'serviceSection' } as const, 'services')
const activity = atom({ plugin: 'nomoreide', key: 'activity' } as const, null)
const databases = atom({ plugin: 'nomoreide', key: 'databases' } as const, [])
const dbTables = atom({ plugin: 'nomoreide', key: 'dbTables' } as const, null)
const dbRows = atom({ plugin: 'nomoreide', key: 'dbRows' } as const, null)
const gitSection = atom({ plugin: 'nomoreide', key: 'gitSection' } as const, 'changes')
const listing = atom({ plugin: 'nomoreide', key: 'listing' } as const, null)
const file = atom({ plugin: 'nomoreide', key: 'file' } as const, null)
const runs = atom({ plugin: 'nomoreide', key: 'runs' } as const, null)
const run = atom({ plugin: 'nomoreide', key: 'run' } as const, null)
const section = atom({ plugin: 'nomoreide', key: 'section' } as const, 'changes')
const changeSets = atom({ plugin: 'nomoreide', key: 'changeSets' } as const, [])
const changeSet = atom({ plugin: 'nomoreide', key: 'changeSet' } as const, null)
const changeDiff = atom({ plugin: 'nomoreide', key: 'changeDiff' } as const, null)
const usage = atom({ plugin: 'nomoreide', key: 'usage' } as const, null)
const tools = atom({ plugin: 'nomoreide', key: 'tools' } as const, null)
const toolKind = atom({ plugin: 'nomoreide', key: 'toolKind' } as const, '')
const tasks = atom({ plugin: 'nomoreide', key: 'tasks' } as const, null)
const confirming = atom({ plugin: 'nomoreide', key: 'confirming' } as const, '')

// Module state is a cache of work in flight, never of what is drawn: a reload
// starts these over and the drawing reads `$.state`, which the host keeps.
let roots: string[] = []
let rootsFor = ''
let rootsAge = ROOTS_EVERY
let gitRun: Promise<void> | undefined
let isGitQueued = false
let daemonRun: Promise<void> | undefined
let daemonPolls = 0
let announced: Set<number> | undefined
let lastStates = new Map<string, string>()
let home: string | undefined
let isBegun = false
let timers: Timer[] = []
let configuredFill = ''
let endpoint: Endpoint | undefined
// When each slower read last ran, by what it read: a view asks again only
// once its answer has aged, however often the pane polls.
let readAt = new Map<string, number>()
let extrasRun: Promise<void> | undefined
// The desktop app gives a pane the keyboard on the first click in it and
// raises that click as a focus move alone, never a press: a click after
// typing in the prompt would need a second one. So the pane keeps what each
// button does, by key, and a click that only brought the focus is answered
// as the press it was.
let presses = new Map<string, () => void>()
let isDesktopFocused: boolean | undefined
let hasTerminal = false
let answered = { key: '', at: 0 }

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Whether a value read from state is another one than what was just loaded:
 * a write redraws every reader, so a poll that found nothing new writes nothing.
 */
const differs = (held: unknown, loaded: unknown): boolean =>
  JSON.stringify(held) !== JSON.stringify(loaded)

// ── git, run in the folder the session works in ────────────────────────────

type Ran = { code: number; out: string; err: string }

async function git(
  $: Engine,
  cwd: string,
  args: readonly string[],
  timeoutMs = 15_000,
): Promise<Ran> {
  try {
    const ran = await $.process.run(['git', ...args], { cwd, timeoutMs })

    return { code: ran.exitCode, out: ran.stdout, err: ran.stderr }
  } catch (error) {
    return { code: 1, out: '', err: reasonOf(error) }
  }
}

// A status read from a timer must never hold the index lock: the person's own
// git, or the agent's, would fail on it.
function peek($: Engine, cwd: string, args: readonly string[]): Promise<Ran> {
  return git($, cwd, ['--no-optional-locks', ...args])
}

/**
 * The repositories a session's folder stands for: the one it is inside, or,
 * for a folder of checkouts, each child that carries a `.git`.
 */
async function findRepos($: Engine, cwd: string): Promise<string[]> {
  const top = await peek($, cwd, ['rev-parse', '--show-toplevel'])
  if (top.code === 0 && top.out.trim() !== '') return [top.out.trim()]

  const found: string[] = []
  try {
    for (const entry of await $.fs.list(cwd)) {
      if (entry.kind !== 'dir' || entry.name.startsWith('.')) continue
      if (entry.name === 'node_modules') continue
      if (await $.fs.exists(`${cwd}/${entry.name}/.git`)) {
        found.push(`${cwd}/${entry.name}`)
      }
      if (found.length === MAX_REPOS) break
    }
  } catch {
    return []
  }

  return found.sort()
}

async function readRepo($: Engine, root: string): Promise<Repo | null> {
  const ran = await peek($, root, ['status', '--porcelain=v1', '--branch', '-z'])
  if (ran.code !== 0) return null

  return { root, name: root.slice(root.lastIndexOf('/') + 1), ...parseStatus(ran.out) }
}

async function readDiff(
  $: Engine,
  root: string,
  file: GitFile,
  staged: boolean,
): Promise<Diff> {
  const args = diffArgs(file, staged)
  const out = args === undefined ? '' : (await peek($, root, args)).out

  return { root, path: file.path, isStaged: staged, ...fitHunks(out) }
}

/** Moves paths into or out of the index; `undefined` when git took it. */
async function moveInIndex(
  $: Engine,
  root: string,
  paths: readonly string[] | 'all',
  toStaged: boolean,
): Promise<string | undefined> {
  const named = paths === 'all' ? [] : ['--', ...paths]
  const ran = toStaged
    ? await git($, root, paths === 'all' ? ['add', '--all'] : ['add', ...named])
    : await git($, root, paths === 'all' ? ['reset', '-q'] : ['restore', '--staged', ...named])
  if (ran.code === 0) return undefined
  if (toStaged) return tail(ran.err || ran.out)
  // Before the first commit there is no HEAD to restore the index from.
  const bare = await git($, root, [
    'rm',
    '--cached',
    '-r',
    '-q',
    ...(paths === 'all' ? ['.'] : named),
  ])

  return bare.code === 0 ? undefined : tail(ran.err || ran.out)
}

async function commit(
  $: Engine,
  root: string,
  message: string,
): Promise<{ isDone: boolean; text: string }> {
  // A repository's own hooks run here, and a slow one is still a commit.
  const ran = await git($, root, ['commit', '-m', message], 120_000)

  return ran.code === 0
    ? { isDone: true, text: ran.out.trim().split('\n')[0] ?? 'Committed.' }
    : { isDone: false, text: tail(ran.err || ran.out) || 'git commit failed.' }
}

// ── the NoMoreIDE daemon, over loopback ────────────────────────────────────

/** Where the shared daemon listens and what it asks for: `~/.nomoreide`. */
async function discover($: Engine): Promise<Endpoint | undefined> {
  try {
    const folder = `${(await $.env.get('HOME')) ?? ''}/.nomoreide`

    return endpointOf(
      await $.fs.read(`${folder}/daemon.json`),
      await $.fs.read(`${folder}/daemon.credential`),
    )
  } catch {
    return undefined
  }
}

type Method = 'GET' | 'POST'

/** One call to the daemon as it answered, body unread; `undefined` when it could not be reached. */
async function call(
  $: Engine,
  path: string,
  method: Method = 'GET',
  body?: unknown,
): Promise<{ status: number; text: string } | undefined> {
  // A daemon that restarted has a new port or a new credential: one more look
  // at its state file settles which.
  for (const isRetry of [false, true]) {
    endpoint ??= await discover($)
    if (endpoint === undefined) return undefined

    try {
      const answer = await $.http.fetch(`${endpoint.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${endpoint.credential}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (answer.status !== 401 || isRetry) return { status: answer.status, text: answer.text }
    } catch {
      if (isRetry) return undefined
    }
    endpoint = undefined
  }

  return undefined
}

async function api($: Engine, path: string, method: Method = 'GET', body?: unknown): Promise<Reply<unknown>> {
  const answer = await call($, path, method, body)

  return answer === undefined ? OFFLINE : replyOf(answer.status, answer.text)
}

async function readServices($: Engine): Promise<Service[] | undefined> {
  const [defined, running] = await Promise.all([api($, '/api/services'), api($, '/api/status')])

  return defined.ok && running.ok ? toServices(defined.value, running.value) : undefined
}

async function readIncidents($: Engine): Promise<Incident[] | undefined> {
  const reply = await api($, '/api/errors?limit=50')

  return reply.ok ? toIncidents(reply.value) : undefined
}

const setPath = (id: string): string => `/api/agent/change-sets/${encodeURIComponent(id)}`

/** A change-set's diff of one file: text, not the API's envelope. */
async function readSetDiff($: Engine, id: string, path: string) {
  const answer = await call($, `${setPath(id)}/diff?path=${encodeURIComponent(path)}`)

  return { id, path, ...fitHunks(answer !== undefined && answer.status === 200 ? answer.text : '') }
}

/** The repository the daemon's snapshot routes act on now. */
async function readActivePath($: Engine): Promise<string> {
  const reply = await api($, '/api/git/worktrees')

  return reply.ok ? toActivePath(reply.value) : ''
}

async function readSnapshots($: Engine): Promise<Snapshots | null> {
  const root = await readActivePath($)
  if (root === '') return null
  const reply = await api($, '/api/snapshots')

  return reply.ok ? toSnapshots(root, reply.value) : null
}

async function readUsage($: Engine): Promise<Usage | undefined> {
  const since = new Date(Date.now() - USAGE_DAYS * 86_400_000).toISOString()
  const [now, history] = await Promise.all([
    api($, '/api/agent/usage'),
    api($, `/api/agent/usage/history?since=${encodeURIComponent(since)}`),
  ])

  return now.ok ? toUsage(now.value, history.ok ? history.value : undefined) : undefined
}

async function readTools($: Engine): Promise<Tools | undefined> {
  const reply = await api($, '/api/agent')

  return reply.ok ? toTools(reply.value) : undefined
}

const linear = ($: Engine, request: Record<string, unknown>): Promise<Reply<unknown>> =>
  api($, '/api/linear/request', 'POST', request)

/** The open Linear work that is the person's own or nobody's. */
async function readTasks($: Engine): Promise<Tasks | undefined> {
  const connection = await api($, '/api/linear/connection')
  if (!connection.ok) return undefined
  if ((connection.value as { connected?: unknown }).connected !== true) return EMPTY_TASKS
  const metadata = await linear($, { operation: 'metadata' })
  if (!metadata.ok) return undefined
  const scope = toLinearScope(metadata.value)
  const found: Task[] = []
  let hasMore = false
  for (const team of scope.teams) {
    let after: string | null = null
    for (let page = 0; page < TASK_PAGES; page += 1) {
      const reply = await linear($, { operation: 'issues', team, project: scope.project, after })
      if (!reply.ok) break
      const read = toTasks(reply.value, scope.viewer)
      found.push(...read.tasks)
      if (read.after === '') {
        after = null
        break
      }
      after = read.after
    }
    hasMore ||= after !== null
  }

  return { isConnected: true, tasks: found, hasMore }
}

/** The branch's pull request, by `gh` in the repository itself; `null` for none, or no `gh`. */
async function readPull($: Engine, root: string): Promise<Pull | null> {
  try {
    const ran = await $.process.run(
      ['gh', 'pr', 'view', '--json', 'number,title,url,state,isDraft,statusCheckRollup'],
      { cwd: root, timeoutMs: 20_000 },
    )

    return ran.exitCode === 0 ? parsePull(root, ran.stdout) : null
  } catch {
    return null
  }
}

/** Whether `what` was read too long ago to stand; saying yes marks it read now. */
function isDue(what: string, force: boolean): boolean {
  const at = readAt.get(what)
  if (!force && at !== undefined && Date.now() - at < SLOW_EVERY_MS) return false
  readAt.set(what, Date.now())

  return true
}

async function readActivity($: Engine): Promise<Activity | undefined> {
  const reply = await api($, '/api/metrics?includeProcesses=1')

  return reply.ok ? toActivity(reply.value) : undefined
}

const dbPath = (name: string): string => `/api/databases/${encodeURIComponent(name)}`

async function readTables($: Engine, database: string): Promise<DbTables> {
  const reply = await api($, `${dbPath(database)}/tables`)

  return reply.ok
    ? { database, tables: toTableNames(reply.value), note: '' }
    : { database, tables: [], note: reply.message }
}

async function readRows($: Engine, database: string, table: string, offset: number): Promise<DbRows> {
  const reply = await api(
    $,
    `${dbPath(database)}/rows?table=${encodeURIComponent(table)}&limit=${DB_PAGE}&offset=${offset}`,
  )

  return reply.ok
    ? toDbRows(database, table, offset, reply.value)
    : { database, table, columns: [], rows: [], rowCount: 0, offset, note: reply.message }
}

/** A folder of the session's own, listed; `null` for one outside it or one that cannot be read. */
async function listDir($: Engine, path: string): Promise<Listing | null> {
  if (!isUnder(path, await $.session.cwd())) return null
  try {
    return { path, entries: sortEntries(await $.fs.list(path)) }
  } catch {
    return null
  }
}

/** A file read for the pane: its text, or the reason it is not shown. */
async function readFile($: Engine, path: string): Promise<OpenFile> {
  try {
    const stat = await $.fs.stat(path)
    if (stat.kind !== 'file') return opened(path, '', 'Not a file.', stat.mtimeMs)
    if (stat.size > MAX_FILE_BYTES) {
      return opened(path, '', `Too large to show here: ${Math.round(stat.size / 1024)} KB.`, stat.mtimeMs)
    }
    const text = await $.fs.read(path)

    return text.includes('\0')
      ? opened(path, '', 'Not a text file.', stat.mtimeMs)
      : opened(path, text, '', stat.mtimeMs)
  } catch (error) {
    return opened(path, '', reasonOf(error), 0)
  }
}

/**
 * Changes one line of the file on screen; the reason when it did not. The
 * file is read again first: what is written is the disk's own text with that
 * one line changed, never the pane's copy of it.
 */
async function editFile($: Engine, edit: Edit): Promise<string | undefined> {
  const open = await read($, file)
  if (open === null || open.note !== '') return 'No file is open to change.'
  if (!isUnder(open.path, await $.session.cwd())) return 'That file is outside this session\'s folder.'
  const disk = await $.fs.read(open.path)
  if (disk !== open.text) {
    const fresh = await readFile($, open.path)
    await update($, file, () => ({ ...fresh, top: open.top, isEditing: true }))

    return 'The file changed on disk since it was read. It is read again: check the line and repeat.'
  }
  const next = applyEdit(disk, edit)
  if (next === undefined) return 'That line is no longer there.'
  await $.fs.write(open.path, next)
  const mtimeMs = (await $.fs.stat(open.path)).mtimeMs
  // A new line is opened for typing; anything else leaves the list of lines.
  const line = edit.kind === 'insert' ? edit.line + 1 : null
  await update($, file, () => ({
    ...open,
    text: next,
    mtimeMs,
    line,
    top: line === null ? open.top : windowFor(line, EDIT_LINES, linesOf(next).length),
  }))

  return undefined
}

/** A branch's recent workflow runs, by `gh` in the repository itself. */
async function readRuns($: Engine, root: string, branch: string): Promise<Runs> {
  try {
    const ran = await $.process.run(
      ['gh', 'run', 'list', '--branch', branch, '--limit', String(MAX_RUNS), '--json', RUN_FIELDS],
      { cwd: root, timeoutMs: 20_000 },
    )

    return ran.exitCode === 0
      ? { root, branch, items: parseRuns(ran.stdout), note: '' }
      : { root, branch, items: [], note: tail(ran.stderr || ran.stdout, 2) || 'gh could not list the runs.' }
  } catch {
    return { root, branch, items: [], note: 'The GitHub CLI (gh) is not installed, or not on the PATH.' }
  }
}

async function readJobs($: Engine, root: string, id: number) {
  try {
    const ran = await $.process.run(['gh', 'run', 'view', String(id), '--json', 'jobs'], {
      cwd: root,
      timeoutMs: 20_000,
    })

    return ran.exitCode === 0 ? parseJobs(ran.stdout) : []
  } catch {
    return []
  }
}

/**
 * The reads only one view shows, made for the view in front and no oftener
 * than a minute apart: GitHub and Linear are other people's servers, and the
 * daemon's agent report is a hundred kilobytes.
 */
async function loadExtras($: Engine, force = false): Promise<void> {
  const shown = await read($, tab)
  const isUp = (await read($, reach)) === 'up'

  if (shown === 'git') {
    const held = await read($, repos)
    const open = await read($, repo)
    const inView = held.length === 1 ? held[0] : held.find(one => one.root === open)
    const part = await read($, gitSection)
    if (part === 'files') {
      const shownFile = await read($, file)
      if (shownFile === null) {
        const found = await listDir($, (await read($, listing))?.path ?? (await $.session.cwd()))
        if (found !== null && differs(await read($, listing), found)) await update($, listing, () => found)
      } else if (shownFile.line === null && shownFile.note === '') {
        // Someone else wrote the file (the agent, an editor): what is shown follows.
        const mtimeMs = await $.fs.stat(shownFile.path).then(stat => stat.mtimeMs).catch(() => 0)
        if (mtimeMs !== shownFile.mtimeMs) {
          const fresh = await readFile($, shownFile.path)
          await update($, file, now =>
            now === null || now.path !== fresh.path ? now : { ...fresh, top: now.top, isEditing: now.isEditing },
          )
        }
      }
    }
    if (part === 'actions' && inView !== undefined && isDue(`runs:${inView.root}:${inView.branch}`, force)) {
      const found = await readRuns($, inView.root, inView.branch)
      if (differs(await read($, runs), found)) await update($, runs, () => found)
      const openRun = await read($, run)
      if (openRun !== null && found.items.some(one => one.id === openRun.id)) {
        const fresh = { id: openRun.id, jobs: await readJobs($, inView.root, openRun.id) }
        if (differs(await read($, run), fresh)) await update($, run, () => fresh)
      }
    }
    if (part === 'changes' && inView !== undefined && isDue(`pull:${inView.root}:${inView.branch}`, force)) {
      const found = await readPull($, inView.root)
      const next = [
        ...(await read($, pulls)).filter(one => one.root !== inView.root),
        ...(found === null ? [] : [found]),
      ]
      if (differs(await read($, pulls), next)) await update($, pulls, () => next)
    }
    if (isUp && isDue('snapshots', force)) {
      const found = await readSnapshots($)
      if (differs(await read($, snapshots), found)) await update($, snapshots, () => found)
    }
  }

  if (shown === 'services' && isUp) {
    const part = await read($, serviceSection)
    // The machine's figures move by the second: read at every poll while they are in front.
    if (part === 'activity') {
      const found = await readActivity($)
      if (found !== undefined && differs(await read($, activity), found)) await update($, activity, () => found)
    }
    if (part === 'database' && isDue('databases', force)) {
      const reply = await api($, '/api/databases')
      if (reply.ok) {
        const found = toDatabases(reply.value)
        if (differs(await read($, databases), found)) await update($, databases, () => found)
      }
    }
  }

  if (shown === 'console' && isUp) {
    const part = await read($, section)
    if (part === 'changes') {
      const reply = await api($, '/api/agent/change-sets')
      if (reply.ok) {
        const cwd = await $.session.cwd()
        const here = toChangeSets(reply.value).filter(
          one => isUnder(one.repoPath, cwd) || isUnder(cwd, one.repoPath),
        )
        if (differs(await read($, changeSets), here)) await update($, changeSets, () => here)
      }
      const open = await read($, changeSet)
      if (open !== null) {
        const files = await api($, setPath(open.id))
        const fresh = { id: open.id, files: files.ok ? toChangeFiles(files.value) : open.files }
        if (differs(await read($, changeSet), fresh)) await update($, changeSet, () => fresh)
      }
    }
    if (part === 'usage' && isDue('usage', force)) {
      const found = await readUsage($)
      if (found !== undefined && differs(await read($, usage), found)) await update($, usage, () => found)
    }
    if (part === 'tools' && isDue('tools', force)) {
      const found = await readTools($)
      if (found !== undefined && differs(await read($, tools), found)) await update($, tools, () => found)
    }
  }

  if (shown === 'linear' && isUp && isDue('tasks', force)) {
    const found = await readTasks($)
    if (found !== undefined) {
      if (differs(await read($, tasks), found)) await update($, tasks, () => found)
      const open = found.tasks.length
      if ((await read($, counts)).tasks !== open) await update($, counts, held => ({ ...held, tasks: open }))
    }
  }
}

/** Reads the view in front afresh, after whatever round is under way. */
async function reloadExtras($: Engine): Promise<void> {
  if (extrasRun !== undefined) await extrasRun
  await refreshExtras($, true)
}

/** One round of those reads at a time; a view opened during one is read by the next. */
function refreshExtras($: Engine, force = false): Promise<void> {
  extrasRun ??= (async () => {
    try {
      await loadExtras($, force)
    } catch {
      // The next poll is the retry.
    } finally {
      extrasRun = undefined
    }
  })()

  return extrasRun
}

async function readLogs($: Engine, name: string): Promise<LogLine[] | undefined> {
  const reply = await api($, `/api/services/${encodeURIComponent(name)}/logs?lines=60`)

  return reply.ok ? toLogs(reply.value) : undefined
}

function actOnService($: Engine, name: string, verb: ServiceVerb): Promise<Reply<unknown>> {
  return api($, `/api/services/${encodeURIComponent(name)}/${verb}`, 'POST')
}

// ── keeping the drawing's state current ────────────────────────────────────

async function loadGit($: Engine): Promise<void> {
  const cwd = await $.session.cwd()
  if ((await read($, workspace)) !== cwd) await update($, workspace, () => cwd)
  if (rootsAge >= ROOTS_EVERY || rootsFor !== cwd) {
    roots = await findRepos($, cwd)
    rootsFor = cwd
    rootsAge = 0
  } else {
    rootsAge += 1
  }

  const read_ = await Promise.all(roots.map(root => readRepo($, root)))
  const loaded = read_.filter((one): one is Repo => one !== null)
  if (differs(await read($, repos), loaded)) await update($, repos, () => loaded)
  const changed = loaded.reduce((sum, one) => sum + one.files.length, 0)
  if ((await read($, counts)).changed !== changed) {
    await update($, counts, held => ({ ...held, changed }))
  }

  // The diff on screen follows its file: reread while the file is still on
  // that side, closed once it is committed, moved or reverted.
  const open = await read($, diff)
  if (open === null) return
  const file = loaded
    .find(one => one.root === open.root)
    ?.files.find(
      one => one.path === open.path && (open.isStaged ? isStaged(one) : isChanged(one)),
    )
  const fresh = file === undefined ? null : await readDiff($, open.root, file, open.isStaged)
  if (differs(await read($, diff), fresh)) await update($, diff, () => fresh)
}

/** One status read at a time; a call during a read is answered by the next. */
function refreshGit($: Engine): Promise<void> {
  if (gitRun !== undefined) {
    isGitQueued = true

    return gitRun
  }
  gitRun = (async () => {
    try {
      do {
        isGitQueued = false
        await loadGit($)
      } while (isGitQueued)
    } catch {
      // A poll that failed is retried by the next one.
    } finally {
      gitRun = undefined
    }
  })()

  return gitRun
}

async function loadDaemon($: Engine): Promise<void> {
  const [liveServices, liveIncidents] = await Promise.all([readServices($), readIncidents($)])
  const reached = liveServices === undefined ? 'down' : 'up'
  if ((await read($, reach)) !== reached) await update($, reach, () => reached)
  if (liveServices === undefined) return

  const isFailed = (one: Service): boolean =>
    one.state === 'exited' && one.exitCode !== null && one.exitCode !== 0
  const tallied = {
    errors: liveIncidents?.length ?? (await read($, counts)).errors,
    live: liveServices.filter(one => ['running', 'starting', 'stopping'].includes(one.state)).length,
    failed: liveServices.filter(isFailed).length,
  }
  const held = await read($, counts)
  if (differs({ ...held, ...tallied }, held)) await update($, counts, now => ({ ...now, ...tallied }))

  if (differs(await read($, services), liveServices)) {
    await update($, services, () => liveServices)
  }
  if (liveIncidents !== undefined && differs(await read($, incidents), liveIncidents)) {
    await update($, incidents, () => liveIncidents)
  }

  // Say what broke while the person was looking elsewhere, once each. What
  // was already there when the mod loaded is not news.
  if (liveIncidents !== undefined) {
    const known = announced
    const fresh = known === undefined ? [] : liveIncidents.filter(one => !known.has(one.id))
    const [first] = fresh
    if (first !== undefined) {
      const rest = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''
      $.ui.toast(`${first.service}: ${first.title.slice(0, 80)}${rest}`)
    }
    announced = new Set(liveIncidents.map(one => one.id))
  }
  const states = new Map<string, string>()
  for (const service of liveServices) {
    const hasFailed =
      service.state === 'exited' && service.exitCode !== null && service.exitCode !== 0
    const before = lastStates.get(service.name)
    if (hasFailed && before !== undefined && before !== 'exited') {
      $.ui.toast(`${service.name} exited with code ${service.exitCode}`)
    }
    states.set(service.name, service.state)
  }
  lastStates = states

  const open = await read($, logs)
  if (open === null) return
  const lines = await readLogs($, open.name)
  if (lines === undefined) return
  const fresh = { name: open.name, lines }
  if (differs(await read($, logs), fresh)) await update($, logs, () => fresh)
}

function refreshDaemon($: Engine): Promise<void> {
  daemonRun ??= (async () => {
    try {
      daemonPolls += 1
      // The theme can change under a long session; a look a minute is plenty.
      if (daemonPolls % 12 === 1) {
        await readTheme($)
        await readFill($)
      }
      await loadDaemon($)
      await refreshExtras($)
    } catch {
      // As for git: the next poll is the retry.
    } finally {
      daemonRun = undefined
    }
  })()

  return daemonRun
}

async function readTheme($: Engine): Promise<void> {
  try {
    const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
    const name = typeof theme === 'string' ? theme : ''
    const isLightNow = name.includes('light')
    // Any other name (`auto`, a custom theme's) is left to the system's appearance.
    const schemeNow = isLightNow ? 'light' : name.includes('dark') ? 'dark' : 'auto'
    if ((await read($, scheme)) !== schemeNow) await update($, scheme, () => schemeNow)
    if ((await read($, isLight)) !== isLightNow) await update($, isLight, () => isLightNow)
  } catch {
    // No theme row to read: the dark palette stands.
  }
}

/**
 * Starts the polling: when the person asks for the pane, and again after a
 * reload that finds it open. Until then the mod does nothing in a session.
 */
function begin($: Engine): void {
  if (isBegun) return
  isBegun = true
  timers = [
    $.clock.every(GIT_EVERY_MS, () => void refreshGit($)),
    $.clock.every(DAEMON_EVERY_MS, () => void refreshDaemon($)),
  ]
  void refreshGit($)
  void refreshDaemon($)
}

/** Stops it: the pane was closed, so nothing is left to keep current. */
function rest(): void {
  for (const timer of timers) timer.cancel()
  timers = []
  isBegun = false
}

/**
 * What to paint the pane with: the colour the person set in the mod's
 * options, else nothing, and Claude Code's own panel fill stands.
 */
async function readFill($: Engine): Promise<void> {
  const found = hexOf(configuredFill)
  if ((await read($, fill)) !== found) await update($, fill, () => found)
}

async function openPane($: Engine, focus: boolean) {
  if (!(await read($, isActive))) await update($, isActive, () => true)
  begin($)
  const placed = await $.ui.open(
    focus
      ? { id: PANE, title: TITLE, columns: COLUMNS, focus: true }
      : { id: PANE, title: TITLE, columns: COLUMNS },
  )
  // The band steps aside for a seated pane, which it learns by drawing again.
  $.ui.invalidate('ui.render')

  return placed
}

/**
 * What a drawing draws from. Each read here subscribes the drawing, and a
 * write to anything it read draws it again, so the pane reads only what the
 * view in front shows: an error that keeps recurring redraws the Errors view
 * and not a file list someone is about to click in.
 */
async function model(
  $: Engine,
  width: number,
  rows = 0,
  isFocused = false,
  isTerminal = true,
  wants: 'view' | 'summary' = 'view',
): Promise<Model> {
  home ??= (await $.env.get('HOME')) ?? ''
  // A session kept from an older build of the mod may name a view since removed.
  const held = await read($, tab)
  const shown = TAB_IDS.includes(held) ? held : 'git'
  const isGit = wants === 'summary' || shown === 'git'
  const gitPart = wants === 'view' && shown === 'git' ? await read($, gitSection) : 'changes'
  const isErrors = wants === 'view' && shown === 'errors'
  const isServices = wants === 'summary' || shown === 'services'
  const servicePart = wants === 'view' && shown === 'services' ? await read($, serviceSection) : 'services'
  const isConsole = wants === 'view' && shown === 'console'
  const isLinear = wants === 'view' && shown === 'linear'
  const part = isConsole ? await read($, section) : 'changes'
  const seen = {
    isLight: read($, isLight),
    scheme: read($, scheme),
    fill: read($, fill),
    reach: read($, reach),
    workspace: read($, workspace),
    counts: read($, counts),
    notice: read($, notice),
    now: $.clock.now(),
    repos: isGit ? read($, repos) : [],
    repo: isGit ? read($, repo) : '',
    diff: isGit ? read($, diff) : null,
    services: isServices ? read($, services) : [],
    showsElsewhere: isServices ? read($, showsElsewhere) : false,
    logs: isServices ? read($, logs) : null,
    activity: servicePart === 'activity' ? read($, activity) : null,
    databases: servicePart === 'database' ? read($, databases) : [],
    dbTables: servicePart === 'database' ? read($, dbTables) : null,
    dbRows: servicePart === 'database' ? read($, dbRows) : null,
    incidents: isErrors ? read($, incidents) : [],
    incident: isErrors ? read($, incident) : null,
    pulls: wants === 'view' && shown === 'git' ? read($, pulls) : [],
    listing: gitPart === 'files' ? read($, listing) : null,
    file: gitPart === 'files' ? read($, file) : null,
    runs: gitPart === 'actions' ? read($, runs) : null,
    run: gitPart === 'actions' ? read($, run) : null,
    snapshots: wants === 'view' && shown === 'git' ? read($, snapshots) : null,
    changeSets: isConsole && part === 'changes' ? read($, changeSets) : [],
    changeSet: isConsole && part === 'changes' ? read($, changeSet) : null,
    changeDiff: isConsole && part === 'changes' ? read($, changeDiff) : null,
    usage: isConsole && part === 'usage' ? read($, usage) : null,
    tools: isConsole && part === 'tools' ? read($, tools) : null,
    toolKind: isConsole && part === 'tools' ? read($, toolKind) : ('' as const),
    tasks: isLinear ? read($, tasks) : null,
    confirming: read($, confirming),
  }
  const tally = await seen.counts

  return {
    width,
    rows,
    isFocused,
    isTerminal,
    fill: await seen.fill,
    colors: palette(await seen.isLight),
    scheme: await seen.scheme,
    home,
    now: await seen.now,
    tab: shown,
    reach: await seen.reach,
    workspace: await seen.workspace,
    counts: { ...tally, tasks: tally.tasks ?? 0 },
    repos: await seen.repos,
    repo: await seen.repo,
    diff: await seen.diff,
    notice: await seen.notice,
    services: await seen.services,
    showsElsewhere: await seen.showsElsewhere,
    logs: await seen.logs,
    serviceSection: servicePart,
    activity: await seen.activity,
    databases: await seen.databases,
    dbTables: await seen.dbTables,
    dbRows: await seen.dbRows,
    incidents: await seen.incidents,
    incident: await seen.incident,
    pulls: await seen.pulls,
    gitSection: gitPart,
    listing: await seen.listing,
    file: await seen.file,
    runs: await seen.runs,
    run: await seen.run,
    snapshots: await seen.snapshots,
    section: part,
    changeSets: await seen.changeSets,
    changeSet: await seen.changeSet,
    changeDiff: await seen.changeDiff,
    usage: await seen.usage,
    tools: await seen.tools,
    toolKind: await seen.toolKind,
    tasks: await seen.tasks,
    confirming: await seen.confirming,
  }
}

/**
 * Opens NoMoreIDE's own dashboard in the person's browser, on its Git page;
 * the reason when it could not.
 */
async function openDashboard($: Engine): Promise<string | undefined> {
  const site = await discover($)
  if (site === undefined) return 'NoMoreIDE is not running, so there is no dashboard to open.'
  try {
    const ran = await $.process.run(['open', `${site.url}/git`], { timeoutMs: 5_000 })

    return ran.exitCode === 0 ? undefined : 'The browser did not open.'
  } catch (error) {
    return reasonOf(error)
  }
}

/** The surface's elements, with each button's press kept by its key as it is drawn. */
function remembering<K extends Kit>(kit: K, surface: string): K {
  const drawn = new Map<string, () => void>()
  presses = drawn

  return {
    ...kit,
    Button: props => {
      const key = props.key ?? props.label
      if (key !== undefined) drawn.set(key, () => props.onPress({ surface } as Parameters<typeof props.onPress>[0]))

      return kit.Button(props)
    },
  }
}

/** What a press does. Each rereads what it acts on: a drawing can be stale. */
function actions($: Engine): Actions {
  const say = async (tone: Notice['tone'], text: string): Promise<void> => {
    await update($, notice, () => ({ tone, text }))
  }
  const hush = async (): Promise<void> => {
    if ((await read($, notice)) !== null) await update($, notice, () => null)
  }
  const guard = (work: () => Promise<void>): Promise<void> =>
    work().catch((error: unknown) => say('bad', reasonOf(error)))

  return {
    setTab: id =>
      guard(async () => {
        if ((await read($, tab)) === id) {
          // The open tab pressed again is the way back to its list.
          if (id === 'git') {
            await update($, diff, () => null)
            await update($, file, () => null)
            await update($, run, () => null)
          }
          if (id === 'errors') await update($, incident, () => null)
          if (id === 'services') {
            await update($, logs, () => null)
            await update($, dbRows, () => null)
            await update($, dbTables, () => null)
          }
          if (id === 'console') {
            await update($, changeDiff, () => null)
            await update($, changeSet, () => null)
          }
        } else {
          await update($, tab, () => id)
        }
        await update($, confirming, () => '')
        await hush()
        await reloadExtras($)
      }),

    setServiceSection: id =>
      guard(async () => {
        await update($, serviceSection, () => id)
        await hush()
        await reloadExtras($)
      }),

    openDatabase: name =>
      guard(async () => {
        const found = await readTables($, name)
        await update($, dbRows, () => null)
        await update($, dbTables, () => found)
      }),
    closeDatabase: () =>
      guard(async () => {
        await update($, dbTables, () => null)
      }),

    openTable: (database, table, offset) =>
      guard(async () => {
        const found = await readRows($, database, table, Math.max(0, offset))
        await update($, dbRows, () => found)
      }),
    closeTable: () =>
      guard(async () => {
        await update($, dbRows, () => null)
      }),

    setGitSection: id =>
      guard(async () => {
        await update($, gitSection, () => id)
        await update($, confirming, () => '')
        await hush()
        if (id === 'files' && (await read($, listing)) === null) {
          const found = await listDir($, await $.session.cwd())
          await update($, listing, () => found)
        }
        await reloadExtras($)
      }),

    openDir: path =>
      guard(async () => {
        const found = await listDir($, path)
        if (found === null) await say('bad', 'That folder cannot be read from here.')
        else await update($, listing, () => found)
      }),

    openFile: path =>
      guard(async () => {
        if (!isUnder(path, await $.session.cwd())) {
          await say('bad', "That file is outside this session's folder.")

          return
        }
        const loaded = await readFile($, path)
        await update($, tab, () => 'git')
        await update($, gitSection, () => 'files')
        await update($, diff, () => null)
        await update($, file, () => loaded)
        await hush()
      }),
    closeFile: () =>
      guard(async () => {
        const open = await read($, file)
        await update($, file, () => null)
        await hush()
        // Back to the folder the file is in, whichever way it was opened.
        if (open !== null) {
          const found = await listDir($, open.path.slice(0, open.path.lastIndexOf('/')))
          if (found !== null) await update($, listing, () => found)
        }
      }),

    pageFile: by =>
      guard(async () => {
        await update($, file, open => {
          if (open === null) return open
          const size = open.isEditing ? EDIT_LINES : VIEW_LINES
          const last = Math.max(0, Math.floor((linesOf(open.text).length - 1) / size) * size)

          return { ...open, line: null, top: Math.max(0, Math.min(last, open.top + by * size)) }
        })
      }),

    toggleEdit: () =>
      guard(async () => {
        await update($, file, open =>
          open === null
            ? open
            : {
                ...open,
                isEditing: !open.isEditing,
                line: null,
                // The same lines stay in view across the two window sizes.
                top: windowFor(open.top + 1, open.isEditing ? VIEW_LINES : EDIT_LINES, linesOf(open.text).length),
              },
        )
        await hush()
      }),

    pickLine: line =>
      guard(async () => {
        await update($, file, open => (open === null ? open : { ...open, line }))
        await hush()
      }),

    editLine: edit =>
      guard(async () => {
        const refusal = await editFile($, edit)
        if (refusal === undefined) await hush()
        else await say('bad', refusal)
        await refreshGit($)
      }),

    sync: (root, verb) =>
      guard(async () => {
        await update($, confirming, () => '')
        const held = (await read($, repos)).find(one => one.root === root)
        if (held === undefined) return
        const args =
          verb === 'fetch'
            ? ['fetch', '--prune']
            : verb === 'pull'
              ? ['pull', '--ff-only']
              : held.upstream === ''
                ? ['push', '-u', 'origin', held.branch]
                : ['push']
        const ran = await git($, root, args, 120_000)
        await say(
          ran.code === 0 ? 'ok' : 'bad',
          ran.code === 0
            ? verb === 'fetch'
              ? 'Fetched.'
              : tail(ran.out || ran.err, 2) || (verb === 'pull' ? 'Pulled.' : 'Pushed.')
            : tail(ran.err || ran.out) || `git ${verb} failed.`,
        )
        await refreshGit($)
        await reloadExtras($)
      }),

    openRun: id =>
      guard(async () => {
        const held = await read($, runs)
        if (held === null) return
        const jobs = await readJobs($, held.root, id)
        await update($, run, () => ({ id, jobs }))
        await hush()
      }),
    closeRun: () =>
      guard(async () => {
        await update($, run, () => null)
      }),

    runToPrompt: id =>
      guard(async () => {
        const held = await read($, runs)
        const failed = held?.items.find(one => one.id === id)
        if (held === null || failed === undefined) return
        const open = await read($, run)
        const jobs = open !== null && open.id === id ? open.jobs : await readJobs($, held.root, id)
        const filled = await $.prompt.fill({ text: toRunPrompt(failed, held.branch, jobs), mode: 'insert' })
        await say(
          filled.isFilled ? 'ok' : 'bad',
          filled.isFilled
            ? 'The failed run is drafted in the prompt. Press Esc to go to it.'
            : 'The prompt box is busy; try again in a moment.',
        )
      }),

    setSection: id =>
      guard(async () => {
        await update($, section, () => id)
        await update($, confirming, () => '')
        await hush()
        await reloadExtras($)
      }),

    openUrl: url =>
      guard(async () => {
        if (!/^https:\/\//.test(url)) return
        const ran = await $.process.run(['open', url], { timeoutMs: 5_000 })
        if (ran.exitCode !== 0) await say('bad', 'The browser did not open.')
      }),

    ask: key =>
      guard(async () => {
        await update($, confirming, () => key)
      }),
    cancel: () =>
      guard(async () => {
        await update($, confirming, () => '')
      }),

    takeSnapshot: root =>
      guard(async () => {
        // The daemon snapshots its selected repository, which can change
        // under an open pane: asked again, so this one is the one it takes.
        if ((await readActivePath($)) !== root) {
          await say('bad', 'NoMoreIDE has another repository selected now; no snapshot was taken.')
        } else {
          const reply = await api($, '/api/snapshots', 'POST', { label: SNAPSHOT_LABEL })
          await say(reply.ok ? 'ok' : 'bad', reply.ok ? 'Snapshot taken.' : reply.message)
        }
        await reloadExtras($)
      }),

    restoreSnapshot: (root, sha) =>
      guard(async () => {
        await update($, confirming, () => '')
        if (!/^[0-9a-f]{7,40}$/i.test(sha) || (await readActivePath($)) !== root) {
          await say('bad', 'NoMoreIDE has another repository selected now; nothing was restored.')
        } else {
          const reply = await api($, `/api/snapshots/${sha}/restore`, 'POST')
          await say(reply.ok ? 'ok' : 'bad', reply.ok ? restoredOf(reply.value) : reply.message)
        }
        await refreshGit($)
        await reloadExtras($)
      }),

    openChangeSet: id =>
      guard(async () => {
        const reply = await api($, setPath(id))
        if (!reply.ok) {
          await say('bad', reply.message)

          return
        }
        const files = toChangeFiles(reply.value)
        await update($, changeSet, () => ({ id, files }))
        await update($, confirming, () => '')
        await hush()
      }),
    closeChangeSet: () =>
      guard(async () => {
        await update($, changeSet, () => null)
        await update($, confirming, () => '')
      }),

    openChangeDiff: (id, path) =>
      guard(async () => {
        const loaded = await readSetDiff($, id, path)
        await update($, changeDiff, () => loaded)
        await hush()
      }),
    closeChangeDiff: () =>
      guard(async () => {
        await update($, changeDiff, () => null)
      }),

    restoreChangeSet: id =>
      guard(async () => {
        await update($, confirming, () => '')
        const reply = await api($, `${setPath(id)}/restore`, 'POST')
        await say(reply.ok ? 'ok' : 'bad', reply.ok ? restoredOf(reply.value) : reply.message)
        await refreshGit($)
        await reloadExtras($)
      }),

    toggleTools: kind =>
      guard(async () => {
        await update($, toolKind, open => (open === kind ? '' : kind))
      }),

    toolToPrompt: (kind, name) =>
      guard(async () => {
        // Only a name the daemon listed goes in, and only as a name: no line breaks, nothing to run.
        const known = (await read($, tools))?.[kind].some(one => one.name === name) === true
        if (!known || /[\r\n]/.test(name)) return
        const text = kind === 'skills' ? `/${name} ` : kind === 'mcp' ? `the ${name} MCP server ` : `the ${name} plugin `
        const filled = await $.prompt.fill({ text, mode: 'insert' })
        await say(
          filled.isFilled ? 'ok' : 'bad',
          filled.isFilled ? 'In the prompt. Press Esc to go back to it.' : 'The prompt box is busy; try again in a moment.',
        )
      }),

    taskToPrompt: id =>
      guard(async () => {
        const task = (await read($, tasks))?.tasks.find(one => one.id === id)
        if (task === undefined) return
        const filled = await $.prompt.fill({ text: toTaskPrompt(task), mode: 'insert' })
        await say(
          filled.isFilled ? 'ok' : 'bad',
          filled.isFilled
            ? `${task.identifier} is drafted in the prompt. Press Esc to go to it.`
            : 'The prompt box is busy; try again in a moment.',
        )
      }),

    openPane: () =>
      guard(async () => {
        await openPane($, true)
      }),

    openWeb: () =>
      guard(async () => {
        const refusal = await openDashboard($)
        await say(refusal === undefined ? 'ok' : 'bad', refusal ?? 'The dashboard is open in your browser.')
      }),

    openRepo: root =>
      guard(async () => {
        await update($, repo, () => root)
        await reloadExtras($)
      }),
    closeRepo: () =>
      guard(async () => {
        await update($, repo, () => '')
      }),

    openDiff: (root, path, staged) =>
      guard(async () => {
        const file = (await read($, repos))
          .find(one => one.root === root)
          ?.files.find(one => one.path === path)
        if (file === undefined) return
        const loaded = await readDiff($, root, file, staged)
        await update($, repo, () => root)
        await update($, diff, () => loaded)
        await hush()
      }),
    closeDiff: () =>
      guard(async () => {
        await update($, diff, () => null)
      }),

    move: (root, paths, toStaged) =>
      guard(async () => {
        const refusal = await moveInIndex($, root, paths, toStaged)
        if (refusal === undefined) {
          await hush()
          // A file moved from its own diff takes the view with it.
          await update($, diff, open =>
            open !== null && open.root === root && paths.includes(open.path)
              ? { ...open, isStaged: toStaged }
              : open,
          )
        } else {
          await say('bad', refusal)
        }
        await refreshGit($)
      }),

    moveAll: (root, toStaged) =>
      guard(async () => {
        const refusal = await moveInIndex($, root, 'all', toStaged)
        if (refusal === undefined) await hush()
        else await say('bad', refusal)
        await refreshGit($)
      }),

    commit: (root, message) =>
      guard(async () => {
        const text = message.trim()
        if (text === '') {
          await say('bad', 'Write a commit message first.')

          return
        }
        const done = await commit($, root, text)
        await say(done.isDone ? 'ok' : 'bad', done.text)
        await refreshGit($)
      }),

    mention: (root, path) =>
      guard(async () => {
        const cwd = await $.session.cwd()
        const absolute = `${root}/${path}`
        const target = absolute.startsWith(`${cwd}/`) ? absolute.slice(cwd.length + 1) : absolute
        const filled = await $.prompt.fill({
          text: /\s/.test(target) ? `@"${target}" ` : `@${target} `,
          mode: 'insert',
        })
        await say(
          filled.isFilled ? 'ok' : 'bad',
          filled.isFilled
            ? 'In the prompt. Press Esc to go back to it.'
            : 'The prompt box is busy; try again in a moment.',
        )
      }),

    openIncident: id =>
      guard(async () => {
        await update($, incident, () => id)
      }),
    closeIncident: () =>
      guard(async () => {
        await update($, incident, () => null)
      }),

    fixIncident: id =>
      guard(async () => {
        const reply = await api($, `/api/errors/${id}/prompt`)
        const prompt = reply.ok ? toFixPrompt(reply.value) : ''
        if (prompt === '') {
          await say('bad', reply.ok ? 'NoMoreIDE had no prompt for that error.' : reply.message)

          return
        }
        const filled = await $.prompt.fill({ text: prompt, mode: 'insert' })
        await say(
          filled.isFilled ? 'ok' : 'bad',
          filled.isFilled
            ? 'The fix is drafted in the prompt. Press Esc to go to it.'
            : 'The prompt box is busy; try again in a moment.',
        )
      }),

    openLogs: name =>
      guard(async () => {
        const lines = (await readLogs($, name)) ?? []
        await update($, logs, () => ({ name, lines }))
        await hush()
      }),
    closeLogs: () =>
      guard(async () => {
        await update($, logs, () => null)
      }),

    toggleElsewhere: () =>
      guard(async () => {
        await update($, showsElsewhere, shown => !shown)
      }),

    service: (name, verb) =>
      guard(async () => {
        const reply = await actOnService($, name, verb)
        if (reply.ok) await hush()
        else await say('bad', `${name}: ${reply.message}`)
        await refreshDaemon($)
      }),
  }
}

export const register: Register = (on, options) => {
  configuredFill = typeof options.background === 'string' ? options.background : ''

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'nomoreide',
      description: 'Open the NoMoreIDE pane: git, errors, services, console, linear',
      argumentHint: '[git|files|actions|errors|services|activity|database|console|changes|usage|tools|linear|web]',
    })

    // Nothing opens by itself: `/nomoreide` does. A reload lands here too,
    // and a pane it finds open goes on being fed.
    void read($, isActive)
      .then(isOn => (isOn ? openPane($, false) : undefined))
      .catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'nomoreide' }, async ($, e) => {
    const asked = e.args.trim().toLowerCase()
    const wanted = TAB_IDS.find(id => asked !== '' && id.startsWith(asked))
    // `web` is the dashboard itself, in the browser: nothing of it is drawn here.
    if (asked === 'web') {
      return { text: (await openDashboard($)) ?? 'The NoMoreIDE dashboard is open in your browser.' }
    }
    const part = SECTION_IDS.find(id => asked !== '' && wanted === undefined && id.startsWith(asked))
    const gitPart = GIT_SECTION_IDS.find(
      id => id !== 'changes' && asked !== '' && wanted === undefined && part === undefined && id.startsWith(asked),
    )
    if (gitPart !== undefined) {
      await update($, tab, () => 'git')
      await update($, gitSection, () => gitPart)
      if (gitPart === 'files' && (await read($, listing)) === null) {
        const found = await listDir($, await $.session.cwd())
        await update($, listing, () => found)
      }
    }
    const servicePart = SERVICE_SECTION_IDS.find(
      id =>
        id !== 'services' &&
        asked !== '' &&
        wanted === undefined &&
        part === undefined &&
        gitPart === undefined &&
        (id.startsWith(asked) || (id === 'database' && asked === 'db')),
    )
    if (servicePart !== undefined) {
      await update($, tab, () => 'services')
      await update($, serviceSection, () => servicePart)
    }
    if (asked !== '' && wanted === undefined && part === undefined && gitPart === undefined && servicePart === undefined) {
      return { text: `No "${asked}" view. There is git (files, actions), errors, services (activity, database), console (changes, usage, tools), linear and web.` }
    }
    if (wanted !== undefined) await update($, tab, () => wanted)
    if (part !== undefined) {
      await update($, tab, () => 'console')
      await update($, section, () => part)
    }
    // Asked for by hand, so it opens on what is true now, not at the last poll.
    await refreshGit($)
    const placed = await openPane($, true)
    // Not waited on: GitHub or Linear answering slowly must not hold the pane.
    void reloadExtras($).catch(() => undefined)

    return placed.isPlaced ? {} : { text: `The NoMoreIDE pane is waiting: ${placed.reason}` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    // Closed by hand is off: no polling, no band, until the command again.
    if (e.origin.kind === 'person') {
      await update($, isActive, () => false)
      rest()
    }

    return next(e)
  })

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const isFirstClick = isFocusOnlyClick({ isDesktopFocused, hasTerminal }, e)
    const press = e.element === undefined ? undefined : presses.get(e.element)
    const moved = await next(e)
    if (isFirstClick && press !== undefined && moved.deny === undefined) {
      answered = { key: e.element ?? '', at: Date.now() }
      press()
    }

    return moved
  })

  on('ui.press', { requestId: PANE }, async ($, e, next) => {
    // Should the app come to raise the press too, it is not done twice.
    if (isEcho(answered, e.element, Date.now())) return { element: e.element }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // One cell of padding each side; docked, the tree fills the room so its
    // key legend sits on the bottom edge. Inline, the frame fits the tree.
    const rows = e.props.placement === 'dock' ? e.props.scroll.bodyRows : 0
    if (e.surface === 'terminal') hasTerminal = true
    if (e.surface === 'desktop') isDesktopFocused = e.props.isFocused

    // A cell grid draws no pictures, whatever its table carries: there the
    // views fall back to their glyphs, as they do wherever `Svg` is missing.
    const { Box, Text, Button, Code, Input, Svg } = $.ui.resolve(e) as Kit
    const kit: Kit = {
      Box,
      Text,
      Button,
      Code,
      ...(Input === undefined ? {} : { Input }),
      ...(Svg === undefined || e.surface === 'terminal' ? {} : { Svg }),
    }

    return pane(
      remembering(kit, e.surface),
      await model($, e.props.bodyColumns - 2, rows, e.props.isFocused, e.surface === 'terminal'),
      actions($),
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The band stands in for a pane that is on but has nowhere to sit.
    if (e.props.hasSurvey || !(await read($, isActive))) return next(e)
    const drawn = await model($, e.props.bodyColumns, 0, false, e.surface === 'terminal', 'summary')
    const panes = await $.ui.panes()
    if (panes.some(one => one.id === PANE && one.isPlaced && one.isShown)) return next(e)

    return band($.ui.resolve(e), drawn, actions($)) ?? next(e)
  })
}
