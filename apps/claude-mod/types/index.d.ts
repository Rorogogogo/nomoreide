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
/**
 * How two measures moved over the daemon's recent samples, thinned to a few
 * dozen points each, the oldest first, across `seconds` in all.
 */
export type Trend = { cpu: number[]; memory: number[]; seconds: number }

export type Activity = {
  /** The processor and memory in use, each a percentage, over the last half hour or so. */
  trend: Trend | null
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

/**
 * A page of one table's rows, every value as the text it is shown as. Drawn
 * as a table: `firstColumn` is the first column in view when they do not all
 * fit, and `record` the row opened to be read whole, counted from 0.
 */
export type DbRows = {
  database: string
  table: string
  columns: string[]
  rows: string[][]
  /** How many rows the table holds; `null` where the engine was not asked. */
  total: number | null
  /** Whether rows follow this page. */
  hasMore: boolean
  offset: number
  firstColumn: number
  record: number | null
  /** The statement these rows answer, when they are a query's and not a table's; `''` otherwise. */
  sql: string
  note: string
}

export type LogLine = { text: string; tone: 'plain' | 'warn' | 'bad' }

/** A service's recent output and, while it runs, its processor share (percent) and memory (megabytes) over time. */
export type Logs = { name: string; lines: LogLine[]; trend: Trend | null }

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

/** The Git tab's views: the working tree, the folder's files, the commit graph, the open pull requests, the branch's workflow runs. */
export type GitSection = 'changes' | 'files' | 'history' | 'pulls' | 'actions'

/**
 * One line of `git log --graph`: the graph's own characters for the line and,
 * where the line is a commit, the commit. A line that only joins lanes has no `sha`.
 */
export type Commit = {
  graph: string
  /** Abbreviated; `''` for a line that is graph alone. */
  sha: string
  subject: string
  author: string
  /** Epoch milliseconds. */
  at: number
  /** Branches, tags and `HEAD` that point here. */
  refs: string[]
}

/** A repository's recent commits across its branches, the newest first. */
export type History = { root: string; rows: Commit[] }

/** One commit opened: what it touched, and the diff of the file picked from that. */
export type OpenCommit = {
  root: string
  sha: string
  subject: string
  author: string
  at: number
  body: string
  files: { status: string; path: string }[]
  diff: { path: string; hunks: string; hiddenLines: number } | null
}

/** A pull request in a repository's list: `Pull`, and whose it is. */
export type PullItem = Pull & { branch: string; author: string; updatedAt: string }

/** A repository's open pull requests; `note` says why there are none to show (no `gh`, no remote). */
export type PullList = { root: string; items: PullItem[]; note: string }

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
  /** Lines of a read shown past the first screenful, as "show more" was pressed. */
  more: number
  isEditing: boolean
  line: number | null
  /** Whether the editor holds changes not yet written to the file. */
  isDirty: boolean
}

/**
 * What the editor shows, as it tells the pane after each key: the lines in
 * view, the first one's number from 0, and where the cursor stands. The pane
 * draws them where the editor itself cannot set type in a fixed-width face.
 */
export type EditView = { path: string; top: number; row: number; col: number; lines: string[] }

/** A line of a file that holds what was searched for; `path` is from the session's folder down. */
export type Hit = { path: string; line: number; text: string }

/** What a search of the session's folder found: files by name, and lines by what they say. */
export type Search = { query: string; names: string[]; hits: Hit[]; isCut: boolean }

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

/**
 * What the Mac says is playing, in whichever app: `elapsed` seconds in as of
 * `at` (epoch milliseconds), which moves on by the clock while it plays.
 */
export type Track = {
  /** The player's bundle identifier. */
  app: string
  title: string
  artist: string
  album: string
  /** Seconds; 0 when the player gave none. */
  duration: number
  elapsed: number
  at: number
  isPlaying: boolean
}

/** One sung line and the second it starts at. */
export type LyricLine = { at: number; text: string }

/** A song's timed lyrics; no lines when none were found. `key` names the song they are for. */
export type Lyrics = { key: string; lines: LyricLine[] }

/** A song's album cover as a small JPEG in base64; `key` names the song it is for. */
export type Cover = { key: string; jpeg: string }

/** The two Claude rate-limit windows; a side is `null` when the daemon has no figure for it. */
export type Limits = { fiveHour: Limit | null; weekly: Limit | null }

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

/**
 * One installed thing: its name, a dim line about it, the scope it is set
 * in, and where it lives (a skill's file, a hook's settings file, a plugin's
 * marketplace). Never a server's address or a hook's command.
 */
export type Tool = { name: string; detail: string; scope: string; where: string }

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
  /** The workflow state a press moves it to, by id: the team's first started and first completed one; `''` for none. */
  startState: string
  doneState: string
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
      history: History | null
      commit: OpenCommit | null
      pullList: PullList | null
      listing: Listing | null
      file: OpenFile | null
      editView: EditView | null
      search: Search | null
      runs: Runs | null
      run: OpenRun | null
      section: Section
      changeSets: ChangeSet[]
      changeSet: OpenChangeSet | null
      changeDiff: ChangeDiff | null
      usage: Usage | null
      /** Read while the mod is on, whatever view is in front: the band above the prompt shows it. */
      limits: Limits | null
      /** Chill mode: what is playing is shown, with its lyrics. Off until asked for. */
      isChill: boolean
      track: Track | null
      lyrics: Lyrics | null
      cover: Cover | null
      /** The now-playing card opened up: a larger cover and more of the lyric. */
      isChillWide: boolean
      /** The lyric line being sung; -1 before the first or with no lyrics. */
      lyricAt: number
      tools: Tools | null
      /** The kind of tool whose list is unfolded; `''` for none. */
      toolKind: ToolKind | ''
      tasks: Tasks | null
      /** The press waiting on a second one before it puts files back; `''` for none. */
      confirming: string
    }
  }
}
