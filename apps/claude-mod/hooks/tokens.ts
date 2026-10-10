import type { Color } from 'claude-code'

/**
 * The dashboard's palette (apps/dashboard/src/styles.css, docs/DESIGN.md) as a
 * terminal takes it: the teal accent, and the five status colours whose
 * meaning is fixed. Everything else is the person's own foreground, dimmed.
 */
export type Palette = {
  /** Focus, selection, and here also "this is a machine identifier". */
  accent: Color
  /** emerald: healthy, running, added */
  ok: Color
  /** red: failure, error, deleted */
  bad: Color
  /** amber: in progress, modified, needs attention */
  busy: Color
  /** purple: merged */
  merged: Color
  /** zinc: stopped, untracked, inert */
  inert: Color
  /** Text on an accent fill: the active tab's pill. */
  onAccent: Color
  /** The fill under the row the pointer is on. */
  hover: Color
  /** A hairline: the theme's own faintest foreground. */
  rule: Color
  /** A drawing's stroke where it stands for the view in front, as hex: an SVG follows no theme. */
  ink: string
  /** The same for a view at rest. */
  inkDim: string
  /** What is cut out of an inked shape: near the surface's own ground. */
  paper: string
}

// --accent is 170 34% 45% on dark and 170 34% 39% on light; status colours are
// the 500 weight on dark and step to 600 where 500 fails contrast on light.
const DARK: Palette = {
  accent: '#4C9A8D',
  ok: '#10B981',
  bad: '#EF4444',
  busy: '#F59E0B',
  merged: '#A855F7',
  inert: '#71717A',
  onAccent: '#0F0E0D',
  hover: '#3A3633',
  rule: 'subtle',
  ink: '#F2F0E9',
  inkDim: '#9C9A92',
  paper: '#1B1B1A',
}

const LIGHT: Palette = {
  accent: '#42857A',
  ok: '#059669',
  bad: '#DC2626',
  busy: '#D97706',
  merged: '#9333EA',
  inert: '#71717A',
  onAccent: '#FFFFFF',
  hover: '#E7E2D9',
  rule: 'subtle',
  ink: '#1F1E1C',
  inkDim: '#75736C',
  paper: '#FFFFFF',
}

export const palette = (isLight: boolean): Palette => (isLight ? LIGHT : DARK)

/**
 * What a file's tag is coloured by its family, as `[on dark, on light]`. A
 * tag is an identifier, not a status, so none of these is the emerald, amber
 * or red a status letter beside it uses: blues, violets, pinks and slate.
 */
export const FAMILY_TONE: Readonly<Record<string, readonly [string, string]>> = {
  typed: ['#60A5FA', '#2563EB'],
  script: ['#22D3EE', '#0891B2'],
  systems: ['#FB7185', '#E11D48'],
  python: ['#A78BFA', '#7C3AED'],
  prose: ['#94A3B8', '#64748B'],
  data: ['#818CF8', '#4F46E5'],
  style: ['#F472B6', '#DB2777'],
  image: ['#E879F9', '#C026D3'],
  shell: ['#2DD4BF', '#0D9488'],
  other: ['#71717A', '#71717A'],
}

/**
 * What a line's parts are coloured by where they are the surface's own text
 * (a file being edited). Theme keys, not hex: such text follows the person's
 * theme where a fixed colour would not.
 */
export const TOKEN_TONE = {
  keyword: 'permission',
  string: 'claude',
  comment: 'inactive',
  number: 'success',
  type: 'planMode',
  call: 'warning',
} as const

export const GLYPH = {
  brand: '◆',
  on: '●',
  off: '○',
  rule: '─',
  bar: '▎',
  dot: '·',
  note: '♪',
  // From the same run of symbols as the player's marks below, so a font draws all four at one size.
  expand: '⏷',
  collapse: '⏶',
  // A player's own marks, each held to its text form: the picture form is a colour emoji.
  previous: '⏮\uFE0E',
  pause: '⏸\uFE0E',
  play: '▶\uFE0E',
  next: '⏭\uFE0E',
  // The same marks for a cell grid, from plain geometric shapes: the player's
  // own marks have a picture form there, which a terminal draws two cells wide
  // and counts as one, so they overlap and push a card's edge off the row.
  cells: { previous: '◂◂', pause: '▮▮', play: '▸', next: '▸▸', expand: '▾', collapse: '▴' },
  /** One cell of a thin meter: a heavy rule, inked for the part used and faint for the rest. */
  meter: '━',
  ahead: '↑',
  behind: '↓',
  add: '+',
  remove: '−',
  times: '×',
  dash: '–',
  /** What stands before a row on a cell grid, where no picture can: a folder's mark, and two-letter tags for the rest. */
  folder: '▸',
  file: '··',
  database: 'db',
  table: 'tb',
  /** A folder that holds something git has to say. */
  changed: '•',
  /** Marks a press that drafts a request to Claude. */
  ask: '✦',
} as const
