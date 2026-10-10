import type {
  Activity,
  ChangeFile,
  ChangeSet,
  Database,
  DbRows,
  Incident,
  Limit,
  Limits,
  LogLine,
  Service,
  Snapshots,
  Task,
  Tasks,
  Tool,
  Tools,
  Trend,
  Usage,
} from '../types'

// The NoMoreIDE daemon's HTTP API, read: the hooks module makes the calls
// and hands their answers here.

export type Endpoint = { url: string; credential: string }

export type Reply<T> =
  | { ok: true; value: T }
  | { ok: false; isOffline: boolean; message: string }

// The daemon binds loopback and says so in its state file. The credential is
// sent nowhere else: a state file naming any other host is not believed.
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/
const CREDENTIAL = /^[0-9a-f]{64}$/i

export const OFFLINE: Reply<never> = {
  ok: false,
  isOffline: true,
  message: 'NoMoreIDE is not running.',
}

/** Where the daemon listens, from `daemon.json` and `daemon.credential`. */
export function endpointOf(stateFile: string, credentialFile: string): Endpoint | undefined {
  let state: unknown
  try {
    state = JSON.parse(stateFile)
  } catch {
    return undefined
  }
  const url = text(field(state, 'url')).replace(/\/+$/, '')
  const credential = credentialFile.trim()

  return LOOPBACK.test(url) && CREDENTIAL.test(credential) ? { url, credential } : undefined
}

/** One answer of the API, its `{ ok, ... }` envelope read. */
export function replyOf(status: number, body: string): Reply<unknown> {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return { ok: false, isOffline: false, message: `NoMoreIDE answered ${status}.` }
  }
  if (status >= 200 && status < 300 && field(value, 'ok') !== false) {
    return { ok: true, value }
  }

  return {
    ok: false,
    isOffline: false,
    message: text(field(value, 'error')) || `NoMoreIDE answered ${status}.`,
  }
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const whole = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const list = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : []

/** Every registered service with what the process manager knows of it. */
export function toServices(defined: unknown, running: unknown): Service[] {
  const statuses = field(field(running, 'status'), 'services')
  const services = list(field(defined, 'services')).map(one => {
    const name = text(field(one, 'name'))
    const status = field(statuses, name)

    return {
      name,
      port: whole(field(one, 'port')),
      cwd: text(field(one, 'cwd')),
      command: text(field(one, 'command')),
      state: text(field(status, 'state')) || 'stopped',
      pid: whole(field(status, 'pid')),
      url: text(field(status, 'url')),
      exitCode: whole(field(status, 'exitCode')),
    }
  })

  return services.filter(service => service.name !== '')
}

export function toIncidents(value: unknown): Incident[] {
  return list(field(value, 'incidents')).flatMap(one => {
    const id = whole(field(one, 'id'))
    const excerpt = field(one, 'logExcerpt')

    return id === null
      ? []
      : [
          {
            id,
            service: text(field(one, 'service')),
            level: text(field(one, 'level')) || 'error',
            title: text(field(one, 'title')) || text(field(one, 'signature')),
            file: text(field(one, 'file')),
            line: whole(field(one, 'line')),
            count: whole(field(one, 'count')) ?? 1,
            firstSeen: text(field(one, 'firstSeen')),
            lastSeen: text(field(one, 'lastSeen')),
            excerpt: Array.isArray(excerpt) ? excerpt.map(text).join('\n') : text(excerpt),
          },
        ]
  })
}

/** Recorded agent sessions, the latest work first. */
export function toChangeSets(value: unknown): ChangeSet[] {
  const sets = list(field(value, 'sessions')).map(one => ({
    id: text(field(one, 'id')),
    label: text(field(one, 'label')),
    provider: text(field(one, 'provider')),
    repoPath: text(field(one, 'repoPath')),
    sha: text(field(one, 'snapshotSha')),
    startedAt: text(field(one, 'startedAt')),
    lastToolAt: text(field(one, 'lastToolAt')),
    toolCount: whole(field(one, 'toolCount')) ?? 0,
  }))

  return sets
    .filter(one => one.id !== '')
    .sort((a, b) => (b.lastToolAt || b.startedAt).localeCompare(a.lastToolAt || a.startedAt))
}

export function toChangeFiles(value: unknown): ChangeFile[] {
  return list(field(value, 'files'))
    .map(one => ({ status: text(field(one, 'status')) || 'M', path: text(field(one, 'path')) }))
    .filter(one => one.path !== '')
}

function toLimit(value: unknown): Limit | null {
  const usedPercent = whole(field(value, 'usedPercent'))
  const resetsAtUnix = whole(field(value, 'resetsAtUnix'))

  return usedPercent === null ? null : { usedPercent, resetsAt: (resetsAtUnix ?? 0) * 1000 }
}

/** The Claude limits alone, off the daemon's usage report. */
export function toLimits(now: unknown): Limits {
  const claude = field(field(now, 'usage'), 'claude')

  return { fiveHour: toLimit(field(claude, 'fiveHour')), weekly: toLimit(field(claude, 'weekly')) }
}

/** What agent work has cost: the limits now, the latest session, and the recorded history's summary. */
export function toUsage(now: unknown, history: unknown): Usage {
  const claude = field(field(now, 'usage'), 'claude')
  const cost = whole(field(claude, 'costUSD'))
  const summary = field(history, 'summary')
  const runs = whole(field(summary, 'runs'))

  return {
    session:
      cost === null
        ? null
        : {
            costUSD: cost,
            linesAdded: whole(field(claude, 'linesAdded')) ?? 0,
            linesRemoved: whole(field(claude, 'linesRemoved')) ?? 0,
          },
    fiveHour: toLimit(field(claude, 'fiveHour')),
    weekly: toLimit(field(claude, 'weekly')),
    period:
      runs === null
        ? null
        : {
            runs,
            costUSD: whole(field(summary, 'totalCostUSD')) ?? 0,
            tokens: whole(field(summary, 'totalTokens')) ?? 0,
            codexTokens: whole(field(summary, 'codexTotalTokens')) ?? 0,
            days: list(field(summary, 'byDay'))
              .map(day => ({ date: text(field(day, 'date')), costUSD: whole(field(day, 'costUSD')) ?? 0 }))
              .filter(day => day.date !== '')
              .slice(-7),
          },
  }
}

/**
 * What Claude Code has installed. Names and where each is set, never a
 * server's address or a hook's command: either can carry a key.
 */
export function toTools(value: unknown): Tools {
  const agent = field(value, 'agent')
  const claude = field(field(agent, 'agents'), 'claude-code') ?? agent
  const parts = (...some: string[]): string => some.filter(part => part !== '').join(' · ')
  const named = (key: string, more: string, where: string): Tool[] =>
    list(field(claude, key))
      .map(one => ({
        name: text(field(one, 'name')),
        detail: parts(text(field(one, 'scope')), text(field(one, more))),
        scope: text(field(one, 'scope')),
        where: text(field(one, where)),
      }))
      .filter(one => one.name !== '')

  return {
    skills: named('skills', '', 'path'),
    mcp: named('mcpServers', 'type', ''),
    plugins: named('plugins', 'version', 'marketplace'),
    hooks: list(field(claude, 'hooks'))
      .map(one => ({
        name: text(field(one, 'event')),
        detail: parts(text(field(one, 'scope')), text(field(one, 'type')), text(field(one, 'status'))),
        scope: text(field(one, 'scope')),
        where: text(field(one, 'settingsPath')),
      }))
      .filter(one => one.name !== ''),
  }
}

/** The daemon's checkpoints of its selected repository, the newest first. */
export function toSnapshots(root: string, value: unknown): Snapshots {
  const items = list(field(value, 'snapshots'))
    .map(one => ({
      sha: text(field(one, 'sha')),
      label: text(field(one, 'label')),
      createdAt: text(field(one, 'createdAt')),
    }))
    .filter(one => /^[0-9a-f]{7,40}$/i.test(one.sha))

  return { root, items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
}

/** The repository the daemon's git, GitHub and snapshot routes act on. */
export const toActivePath = (value: unknown): string => text(field(value, 'activePath')).replace(/\/+$/, '')

/** The two states a press moves an issue to, per team, by id. */
export type TeamMoves = Record<string, { start: string; done: string }>

export type LinearScope = { viewer: string; teams: string[]; project: string | null; moves: TeamMoves }

/** Who is asking and where their work is filed: the bound team, else every team. */
export function toLinearScope(value: unknown): LinearScope {
  const data = field(value, 'data')
  const bound = text(field(field(data, 'binding'), 'team'))
  const project = text(field(field(data, 'binding'), 'project'))
  const nodes = list(field(field(data, 'teams'), 'nodes'))
  const teams = nodes.map(one => text(field(one, 'id'))).filter(id => id !== '')
  const stateOf = (team: unknown, type: string): string =>
    text(field(list(field(field(team, 'states'), 'nodes')).find(state => field(state, 'type') === type), 'id'))
  const moves: TeamMoves = {}
  for (const team of nodes) {
    moves[text(field(team, 'id'))] = { start: stateOf(team, 'started'), done: stateOf(team, 'completed') }
  }

  return {
    viewer: text(field(field(data, 'viewer'), 'id')),
    teams: bound === '' ? teams.slice(0, 3) : [bound],
    project: bound === '' || project === '' ? null : project,
    moves,
  }
}

const OPEN_STATES = ['started', 'unstarted', 'backlog', 'triage']

/**
 * One page of a team's issues, cut to the work still open that is the
 * person's own or nobody's; `after` is where the next page starts.
 */
export function toTasks(
  value: unknown,
  viewer: string,
  moves: TeamMoves = {},
): { tasks: Task[]; after: string } {
  const issues = field(field(value, 'data'), 'issues')
  const page = field(issues, 'pageInfo')
  const tasks = list(field(issues, 'nodes')).map(one => {
    const assignee = field(one, 'assignee')
    const move = moves[text(field(field(one, 'team'), 'id'))]

    return {
      id: text(field(one, 'id')),
      identifier: text(field(one, 'identifier')),
      title: text(field(one, 'title')),
      url: text(field(one, 'url')),
      branch: text(field(one, 'branchName')),
      state: text(field(field(one, 'state'), 'name')),
      stateType: text(field(field(one, 'state'), 'type')),
      project: text(field(field(one, 'project'), 'name')),
      assignee: text(field(assignee, 'name')),
      isMine: viewer !== '' && text(field(assignee, 'id')) === viewer,
      updatedAt: text(field(one, 'updatedAt')),
      description: text(field(one, 'description')).slice(0, 4000),
      startState: move?.start ?? '',
      doneState: move?.done ?? '',
    }
  })

  return {
    tasks: tasks.filter(
      one => one.id !== '' && OPEN_STATES.includes(one.stateType) && (one.isMine || one.assignee === ''),
    ),
    after: field(page, 'hasNextPage') === true ? text(field(page, 'endCursor')) : '',
  }
}

/** The dashboard's own words for handing a Linear task to an agent. */
export function toTaskPrompt(task: Task): string {
  return `Work on Linear task ${task.identifier}: ${task.title}\n${task.url}\n\n${task.description}\n\nSuggested branch: ${task.branch}\nRead the repository instructions, implement the task, and verify the changes. Include ${task.identifier} in the pull request so Linear can link it.`
}

export const EMPTY_TASKS: Tasks = { isConnected: false, tasks: [], hasMore: false }

export function toLogs(value: unknown): LogLine[] {
  return list(field(value, 'logs')).map(one => {
    const severity = text(field(one, 'severity'))

    return {
      text: text(field(one, 'text')).slice(0, 400),
      tone: severity === 'error' ? 'bad' : severity === 'warning' ? 'warn' : 'plain',
    }
  })
}

/** The prompt the daemon writes for an incident: the error, its file, its logs. */
export const toFixPrompt = (value: unknown): string => text(field(value, 'prompt'))

/** What a restore did, in the dashboard's words: what went back, and the way to undo it. */
export function restoredOf(value: unknown): string {
  const done = value as { restoredFiles?: unknown; deletedPaths?: unknown; preRestore?: { sha?: unknown } }
  const files = typeof done.restoredFiles === 'number' ? done.restoredFiles : 0
  const removed = Array.isArray(done.deletedPaths) ? done.deletedPaths.length : 0
  const undo = typeof done.preRestore?.sha === 'string' ? done.preRestore.sha.slice(0, 7) : ''

  return (
    `Restored ${files} file${files === 1 ? '' : 's'}` +
    (removed > 0 ? `, removed ${removed}` : '') +
    (undo === '' ? '.' : `. To undo, restore snapshot ${undo}.`)
  )
}

/** How many of the busiest processes the Activity view names. */
const TOP_PROCESSES = 8

/** A command line's executable, by its own name: never its arguments, which can carry a key. */
function programOf(command: string): string {
  // An app bundle's path has spaces in it, so there the program is what
  // follows the last `/` before any flag; anywhere else it is the first word.
  const program = command.includes('.app/')
    ? (command.split(/\s+-/)[0] ?? command)
    : (command.trim().split(/\s+/)[0] ?? command)

  return program.slice(program.lastIndexOf('/') + 1).slice(0, 60)
}

/** `/api/metrics?includeProcesses=1`, read down to what a pane shows. */
export function toActivity(value: unknown): Activity | undefined {
  const metrics = field(value, 'metrics')
  const now = field(field(metrics, 'host'), 'current')
  const total = whole(field(now, 'memoryTotalBytes'))
  if (total === null) return undefined
  const disk = field(now, 'disk')
  const diskUsed = whole(field(disk, 'usedPercent'))
  const services = field(metrics, 'services')
  const processes = list(field(metrics, 'systemProcesses')).map(one => ({
    pid: whole(field(one, 'pid')) ?? 0,
    name: programOf(text(field(one, 'command'))),
    cpuPercent: whole(field(one, 'cpuPercent')) ?? 0,
    rssMb: whole(field(one, 'rssMb')) ?? 0,
    service: text(field(one, 'managedService')),
  }))

  return {
    trend: toTrend(field(field(metrics, 'host'), 'samples'), 'cpuPercent', 'memoryUsedPercent'),
    cpuPercent: whole(field(now, 'cpuPercent')),
    cores: whole(field(now, 'logicalCpuCount')) ?? 0,
    load: whole(list(field(now, 'loadAverage'))[0]),
    memory: {
      usedPercent: whole(field(now, 'memoryUsedPercent')) ?? 0,
      usedBytes: whole(field(now, 'memoryUsedBytes')) ?? 0,
      totalBytes: total,
    },
    disk:
      diskUsed === null
        ? null
        : { usedPercent: diskUsed, availableBytes: whole(field(disk, 'availableBytes')) ?? 0 },
    services: (typeof services === 'object' && services !== null ? Object.values(services) : [])
      .map(one => ({
        name: text(field(one, 'service')),
        cpuPercent: whole(field(one, 'cpuPercent')) ?? 0,
        rssMb: whole(field(one, 'rssMb')) ?? 0,
      }))
      .filter(one => one.name !== '')
      .sort((a, b) => b.cpuPercent - a.cpuPercent || b.rssMb - a.rssMb),
    processes: processes
      .filter(one => one.name !== '')
      .sort((a, b) => b.cpuPercent - a.cpuPercent || b.rssMb - a.rssMb)
      .slice(0, TOP_PROCESSES),
  }
}

/** The registered connections by name and engine. Their `url` is left behind: it holds the password. */
export function toDatabases(value: unknown): Database[] {
  return list(field(value, 'connections'))
    .map(one => ({
      name: text(field(one, 'name')),
      engine: text(field(one, 'engine')),
      isWritable: field(one, 'writeUnlocked') === true,
    }))
    .filter(one => one.name !== '')
}

export function toTableNames(value: unknown): string[] {
  return list(field(value, 'tables'))
    .map(one => text(field(one, 'qualifiedName')) || text(field(one, 'name')))
    .filter(name => name !== '')
}

/** How long a cell's text may run before it is cut. */
const MAX_CELL = 200

function cellOf(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  const shown = typeof value === 'object' ? JSON.stringify(value) : String(value)

  return shown.length > MAX_CELL ? `${shown.slice(0, MAX_CELL)}…` : shown
}

/**
 * A page of a table's rows: each row's values in column order, as text.
 * Columns come as names or as `{ name }`; `total` is the table's own count
 * where one was asked for, and `size` the page asked for.
 */
export function toDbRows(
  database: string,
  table: string,
  offset: number,
  value: unknown,
  size: number,
  total: number | null = null,
): DbRows {
  const columns = list(field(value, 'columns'))
    .map(one => (typeof one === 'string' ? one : text(field(one, 'name'))))
    .filter(name => name !== '')
  const rows = list(field(value, 'rows')).map(one => columns.map(column => cellOf(field(one, column))))

  return {
    database,
    table,
    columns,
    rows,
    total,
    hasMore: total === null ? rows.length >= size : offset + rows.length < total,
    offset,
    firstColumn: 0,
    record: null,
    sql: '',
    note: '',
  }
}

/** A table's columns as the rows endpoint names them, the primary key's first. */
export function toColumns(value: unknown): { name: string; isKey: boolean }[] {
  return list(field(value, 'columns'))
    .map(one => ({ name: text(field(one, 'name')), isKey: field(one, 'primaryKey') === true }))
    .filter(one => one.name !== '')
}

/** A Postgres identifier, quoted: nothing in a name can end the quoting. */
const quoted = (name: string): string => `"${name.replace(/"/g, '""')}"`

/** `schema.table` as the daemon lists it, each part quoted. */
function quotedTable(table: string): string {
  const cut = table.indexOf('.')

  return cut < 0 ? quoted(table) : `${quoted(table.slice(0, cut))}.${quoted(table.slice(cut + 1))}`
}

/**
 * One page of a Postgres table, every column cast to text. The daemon's row
 * endpoint answers `null` for a timestamp, a uuid and a bytea; a cast gives
 * each as Postgres itself writes it. Ordered by the primary key so a page is
 * the same rows twice. A read and nothing else: the names are quoted, the
 * numbers are numbers, and nothing the person typed is in it.
 */
export function pageSql(
  table: string,
  columns: readonly { name: string; isKey: boolean }[],
  limit: number,
  offset: number,
): string {
  const picked = columns.map(one => `${quoted(one.name)}::text AS ${quoted(one.name)}`).join(', ')
  const keys = columns.filter(one => one.isKey).map(one => quoted(one.name))
  const order = keys.length > 0 ? ` ORDER BY ${keys.join(', ')}` : ''

  return `SELECT ${picked} FROM ${quotedTable(table)}${order} LIMIT ${Math.floor(limit)} OFFSET ${Math.max(0, Math.floor(offset))}`
}

export const countSql = (table: string): string => `SELECT count(*)::text AS "n" FROM ${quotedTable(table)}`

/** What `countSql` answered, as a number. */
export function toCount(value: unknown): number | null {
  const n = Number(field(list(field(value, 'rows'))[0], 'n'))

  return Number.isFinite(n) ? n : null
}

/**
 * A Postgres query as one that answers each row as JSON text, or `undefined`
 * for a statement that cannot stand inside another (`SHOW`, `EXPLAIN`). The
 * daemon's query route answers `null` for a timestamp, a uuid and a bytea;
 * as JSON each comes back written out, in the query's own column order.
 */
export function jsonSql(sql: string): string | undefined {
  const statement = sql.trim().replace(/;+\s*$/, '')
  if (!/^(select|with|values|table)\b/i.test(statement) || statement.includes(';')) return undefined

  return `SELECT row_to_json("q")::text AS "j" FROM (${statement}) AS "q"`
}

/** What `jsonSql` answered, back in the shape of a plain query's answer; `undefined` if it is not that. */
export function fromJsonRows(value: unknown): { columns: string[]; rows: Record<string, unknown>[] } | undefined {
  const rows: Record<string, unknown>[] = []
  for (const one of list(field(value, 'rows'))) {
    try {
      const row: unknown = JSON.parse(text(field(one, 'j')))
      if (typeof row !== 'object' || row === null) return undefined
      rows.push(row as Record<string, unknown>)
    } catch {
      return undefined
    }
  }
  const [first] = rows

  return { columns: first === undefined ? [] : Object.keys(first), rows }
}

/** How many points a trend keeps: enough for a line, few enough to hold in state and redraw. */
export const TREND_POINTS = 60

/** `values` thinned to at most `points`, each the mean of its stretch. */
export function thin(values: readonly number[], points = TREND_POINTS): number[] {
  if (values.length <= points) return [...values]
  const out: number[] = []
  for (let at = 0; at < points; at += 1) {
    const part = values.slice(Math.floor((at * values.length) / points), Math.floor(((at + 1) * values.length) / points))
    out.push(Math.round((part.reduce((sum, one) => sum + one, 0) / Math.max(1, part.length)) * 10) / 10)
  }

  return out
}

/** The daemon's samples (each with a time `t`) as a trend of two of their fields; `null` with fewer than two. */
export function toTrend(samples: unknown, cpuKey: string, memoryKey: string): Trend | null {
  const rows = list(samples)
  if (rows.length < 2) return null
  const first = whole(field(rows[0], 't')) ?? 0
  const last = whole(field(rows[rows.length - 1], 't')) ?? 0

  return {
    cpu: thin(rows.map(one => whole(field(one, cpuKey)) ?? 0)),
    memory: thin(rows.map(one => whole(field(one, memoryKey)) ?? 0)),
    seconds: Math.max(0, Math.round((last - first) / 1000)),
  }
}

/** One service's own series off `/api/services/<name>/metrics`: processor percent and resident megabytes. */
export function toServiceTrend(value: unknown): Trend | null {
  return toTrend(field(field(value, 'metrics'), 'samples'), 'cpu', 'rss')
}
