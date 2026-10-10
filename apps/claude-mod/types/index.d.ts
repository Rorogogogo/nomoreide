export type Tab = 'git' | 'errors' | 'services' | 'console' | 'linear'

/** The Console's three views, as the dashboard's Agent Console names them. */
export type Section = 'changes' | 'usage' | 'tools'

/** Whether the person's theme is light or dark by name, or follows the system. */
export type Scheme = 'light' | 'dark' | 'auto'

/** Whether the NoMoreIDE daemon answered the last time it was asked. */
export type Reach = 'unknown' | 'up' | 'down'

/** One path of `git status`: its index and working-tree letters (`' '` is unchanged). */
export type GitFile = { path: string; index: string; workingTree: string }

export type Repo = {
  root: string
  name: string
  branch: string
  upstream: string
  ahead: number
  behind: number
  files: GitFile[]
}

/** The diff on screen: unified hunks alone, cut to what one pane can hold. */
export type Diff = {
  root: string
  path: string
  isStaged: boolean
  hunks: string
  hiddenLines: number
}

export type Notice = { tone: 'ok' | 'bad'; text: string }

export type Service = {
  name: string
  port: number | null
  cwd: string
  command: string
  state: string
  pid: number | null
  url: string
  exitCode: number | null
}

/** The Services tab's three views: what runs, what it costs the machine, and the data beside it. */
export type ServiceSection = 'services' | 'activity' | 'database'

/** What the machine is doing now, and which processes are doing it. */
export type Activity = {
  cpuPercent: number | null
  cores: number
  load: number | null
  memory: { usedPercent: number; usedBytes: number; totalBytes: number }
  disk: { usedPercent: number; availableBytes: number } | null
  services: { name: string; cpuPercent: number; rssMb: number }[]
  /** The busiest few, by executable name alone: a command line can carry a key. */
  processes: { pid: number; name: string; cpuPercent: number; rssMb: number; service: string }[]
}

/** A registered connection, without its address: that holds the password. */
export type Database = { name: string; engine: string; isWritable: boolean }

export type DbTables = { database: string; tables: string[]; note: string }

/** A page of one table's rows, every value as the text it is shown as. */
export type DbRows = {
  database: string
  table: string
  columns: string[]
  rows: string[][]
  rowCount: number
  offset: number
  note: string
}

export type LogLine = { text: string; tone: 'plain' | 'warn' | 'bad' }

export type Logs = { name: string; lines: LogLine[] }

export type Incident = {
  id: number
  service: string
  level: string
  title: string
  file: string
  line: number | null
  count: number
  firstSeen: string
  lastSeen: string
  excerpt: string
}

/** What the header and the tab badges say; kept apart from the lists so a view redraws for its own data only. */
export type Counts = { changed: number; errors: number; live: number; failed: number; tasks: number }

/** A pull request for a repository's branch and how its checks stand, as `gh` reports them. */
export type Pull = {
  root: string
  number: number
  title: string
  url: string
  /** `OPEN`, `MERGED` or `CLOSED`. */
  state: string
  isDraft: boolean
  checks: 'none' | 'passing' | 'failing' | 'running'
  passed: number
  total: number
}

/** The Git tab's three views: the working tree, the folder's files, the branch's workflow runs. */
export type GitSection = 'changes' | 'files' | 'actions'

export type Entry = { name: string; kind: 'file' | 'dir' | 'other' }

/** One folder of the session's own, as listed: an absolute path and what it holds. */
export type Listing = { path: string; entries: Entry[] }

/**
 * The file on screen. `text` is the whole of it, or `''` with `note` saying
 * why it is not shown (too large, not text). `line` is the one being edited,
 * counted from 1.
 */
export type OpenFile = {
  path: string
  text: string
  note: string
  mtimeMs: number
  /** The first line of the window shown, counted from 0. */
  top: number
  isEditing: boolean
  line: number | null
}

/** One GitHub Actions workflow run, as `gh run list` reports it. */
export type Run = {
  id: number
  workflow: string
  title: string
  /** `queued`, `in_progress`, `completed`. */
  status: string
  /** `success`, `failure`, `cancelled`, `skipped`, ... or `''` while it runs. */
  conclusion: string
  event: string
  createdAt: string
  url: string
}

export type Job = { name: string; status: string; conclusion: string; failedStep: string }

/** A branch's recent runs; `note` says why there are none to show (no `gh`, no remote). */
export type Runs = { root: string; branch: string; items: Run[]; note: string }

export type OpenRun = { id: number; jobs: Job[] }

export type Snapshot = { sha: string; label: string; createdAt: string }

/** The daemon's checkpoints, and the one repository they are of: its selected one. */
export type Snapshots = { root: string; items: Snapshot[] }

/** One recorded agent session, pinned to the snapshot taken before its work. */
export type ChangeSet = {
  id: string
  label: string
  provider: string
  repoPath: string
  /** `''` when the session was recorded before a snapshot could be taken. */
  sha: string
  startedAt: string
  lastToolAt: string
  toolCount: number
}

/** A path that differs from a snapshot: `A`dded since, `M`odified, `D`eleted. */
export type ChangeFile = { status: string; path: string }

export type OpenChangeSet = { id: string; files: ChangeFile[] }

export type ChangeDiff = { id: string; path: string; hunks: string; hiddenLines: number }

/** A rate-limit window: how much is used and when it starts over, in epoch milliseconds. */
export type Limit = { usedPercent: number; resetsAt: number }

export type Usage = {
  /** The latest Claude session the daemon saw; `null` when it has seen none. */
  session: { costUSD: number; linesAdded: number; linesRemoved: number } | null
  fiveHour: Limit | null
  weekly: Limit | null
  /** The last thirty days of recorded runs. */
  period: {
    runs: number
    costUSD: number
    tokens: number
    codexTokens: number
    days: { date: string; costUSD: number }[]
  } | null
}

export type Tool = { name: string; detail: string }

/** What Claude Code has installed, by kind. */
export type Tools = { skills: Tool[]; mcp: Tool[]; plugins: Tool[]; hooks: Tool[] }

export type ToolKind = keyof Tools

export type Task = {
  id: string
  identifier: string
  title: string
  url: string
  branch: string
  state: string
  /** Linear's fixed kinds: `started`, `unstarted`, `backlog`, `triage`. */
  stateType: string
  project: string
  /** `''` for nobody. */
  assignee: string
  isMine: boolean
  updatedAt: string
  description: string
}

export type Tasks = { isConnected: boolean; tasks: Task[]; hasMore: boolean }

declare module 'claude-code' {
  interface PluginState {
    nomoreide: {
      tab: Tab
      /** On from `/nomoreide` until the pane is closed by hand; off, the mod is idle. */
      isActive: boolean
      isLight: boolean
      scheme: Scheme
      /** The hex the pane is painted with, to sit level with the terminal; `''` leaves the engine's fill. */
      fill: string
      reach: Reach
      counts: Counts
      workspace: string
      repos: Repo[]
      /** The repository in view when the workspace holds several; `''` is the board. */
      repo: string
      diff: Diff | null
      notice: Notice | null
      services: Service[]
      /** Whether services of other projects are listed, or only counted. */
      showsElsewhere: boolean
      logs: Logs | null
      serviceSection: ServiceSection
      activity: Activity | null
      databases: Database[]
      dbTables: DbTables | null
      dbRows: DbRows | null
      incidents: Incident[]
      incident: number | null
      /** Pull requests of the repositories looked at, one per branch that has one. */
      pulls: Pull[]
      snapshots: Snapshots | null
      gitSection: GitSection
      listing: Listing | null
      file: OpenFile | null
      runs: Runs | null
      run: OpenRun | null
      section: Section
      changeSets: ChangeSet[]
      changeSet: OpenChangeSet | null
      changeDiff: ChangeDiff | null
      usage: Usage | null
      tools: Tools | null
      /** The kind of tool whose list is unfolded; `''` for none. */
      toolKind: ToolKind | ''
      tasks: Tasks | null
      /** The press waiting on a second one before it puts files back; `''` for none. */
      confirming: string
    }
  }
}
