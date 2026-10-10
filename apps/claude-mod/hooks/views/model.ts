import type { Elements } from 'claude-code'

import type {
  Activity,
  ChangeDiff,
  ChangeSet,
  Counts,
  Database,
  DbRows,
  DbTables,
  Diff,
  GitSection,
  Incident,
  Listing,
  Logs,
  Notice,
  OpenChangeSet,
  OpenFile,
  OpenRun,
  Pull,
  Reach,
  Repo,
  Runs,
  Scheme,
  Section,
  Service,
  ServiceSection,
  Snapshots,
  Tab,
  Tasks,
  ToolKind,
  Tools,
  Usage,
} from '../../types'
import type { Edit } from '../files'
import type { Palette } from '../tokens'

/** The elements every surface that seats a pane has; `Input` where it has one. */
export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Code'> &
  Partial<Pick<Elements['terminal'], 'Input'>> &
  Partial<Pick<Elements['desktop'], 'Svg'>>

export type Model = {
  /** Cells across, inside the padding. */
  width: number
  /** The room's rows when the pane is docked, so the legend sits at its foot; 0 inline. */
  rows: number
  isFocused: boolean
  /** A grid of character cells, or a surface that sets type (the desktop app, an editor). */
  isTerminal: boolean
  /** The terminal's own background as hex, painted over the engine's panel fill; `''` for none. */
  fill: string
  colors: Palette
  /** What a drawing's ink follows: the theme by name, or the system. */
  scheme: Scheme
  home: string
  now: number
  tab: Tab
  reach: Reach
  workspace: string
  /** What the header and every tab's badge say: kept apart so a view is redrawn for its own data only. */
  counts: Counts
  repos: readonly Repo[]
  repo: string
  diff: Diff | null
  notice: Notice | null
  services: readonly Service[]
  showsElsewhere: boolean
  logs: Logs | null
  serviceSection: ServiceSection
  activity: Activity | null
  databases: readonly Database[]
  dbTables: DbTables | null
  dbRows: DbRows | null
  incidents: readonly Incident[]
  incident: number | null
  pulls: readonly Pull[]
  gitSection: GitSection
  listing: Listing | null
  file: OpenFile | null
  runs: Runs | null
  run: OpenRun | null
  snapshots: Snapshots | null
  section: Section
  changeSets: readonly ChangeSet[]
  changeSet: OpenChangeSet | null
  changeDiff: ChangeDiff | null
  usage: Usage | null
  tools: Tools | null
  toolKind: ToolKind | ''
  tasks: Tasks | null
  /** The press that is waiting on its second one; `''` for none. */
  confirming: string
}

export type ServiceVerb = 'start' | 'stop' | 'restart'

export type SyncVerb = 'fetch' | 'pull' | 'push'

export type Actions = {
  setTab: (tab: Tab) => Promise<void>
  setSection: (section: Section) => Promise<void>
  setGitSection: (section: GitSection) => Promise<void>
  setServiceSection: (section: ServiceSection) => Promise<void>
  openDatabase: (name: string) => Promise<void>
  closeDatabase: () => Promise<void>
  openTable: (database: string, table: string, offset: number) => Promise<void>
  closeTable: () => Promise<void>
  openDir: (path: string) => Promise<void>
  openFile: (path: string) => Promise<void>
  closeFile: () => Promise<void>
  /** Moves the window of lines shown by so many windows, back or on. */
  pageFile: (by: number) => Promise<void>
  toggleEdit: () => Promise<void>
  pickLine: (line: number | null) => Promise<void>
  editLine: (edit: Edit) => Promise<void>
  sync: (root: string, verb: SyncVerb) => Promise<void>
  openRun: (id: number) => Promise<void>
  closeRun: () => Promise<void>
  runToPrompt: (id: number) => Promise<void>
  openUrl: (url: string) => Promise<void>
  ask: (key: string) => Promise<void>
  cancel: () => Promise<void>
  takeSnapshot: (root: string) => Promise<void>
  restoreSnapshot: (root: string, sha: string) => Promise<void>
  openChangeSet: (id: string) => Promise<void>
  closeChangeSet: () => Promise<void>
  openChangeDiff: (id: string, path: string) => Promise<void>
  closeChangeDiff: () => Promise<void>
  restoreChangeSet: (id: string) => Promise<void>
  toggleTools: (kind: ToolKind) => Promise<void>
  toolToPrompt: (kind: ToolKind, name: string) => Promise<void>
  taskToPrompt: (id: string) => Promise<void>
  openPane: () => Promise<void>
  openWeb: () => Promise<void>
  openRepo: (root: string) => Promise<void>
  closeRepo: () => Promise<void>
  openDiff: (root: string, path: string, staged: boolean) => Promise<void>
  closeDiff: () => Promise<void>
  move: (root: string, paths: readonly string[], toStaged: boolean) => Promise<void>
  moveAll: (root: string, toStaged: boolean) => Promise<void>
  commit: (root: string, message: string) => Promise<void>
  mention: (root: string, path: string) => Promise<void>
  openIncident: (id: number) => Promise<void>
  closeIncident: () => Promise<void>
  fixIncident: (id: number) => Promise<void>
  openLogs: (name: string) => Promise<void>
  closeLogs: () => Promise<void>
  toggleElsewhere: () => Promise<void>
  service: (name: string, verb: ServiceVerb) => Promise<void>
}
