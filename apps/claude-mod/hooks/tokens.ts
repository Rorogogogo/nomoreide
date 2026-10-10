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

export const GLYPH = {
  brand: '◆',
  on: '●',
  off: '○',
  rule: '─',
  bar: '▎',
  dot: '·',
  ahead: '↑',
  behind: '↓',
  add: '+',
  remove: '−',
  times: '×',
  dash: '–',
} as const
