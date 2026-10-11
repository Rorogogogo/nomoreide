import type { Scheme, Tab } from '../types'
import type { Family } from './files'
import type { DiffRow } from './git'
import { highlight, isHighlighted, sliceTokens } from './highlight'
import { palette } from './tokens'

// The dashboard's own navigation icons (components/app-navigation.tsx), as
// lucide draws them: a 24-unit grid, a two-unit round stroke, no fill.
const SHAPES: Record<Exclude<Tab, 'linear'>, string> = {
  // GitBranch
  git: '<path d="M15 6a9 9 0 0 0-9 9V3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>',
  // Inbox
  errors:
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  // Server
  services:
    '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  // Bot
  console:
    '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
}

// Linear's own mark (features/linear/linear-logo.tsx): a filled shape, not a stroke.
const LINEAR =
  '<path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"/>'

type Ink = 'ink' | 'inkDim' | 'paper'

/**
 * A style sheet giving each class its colour from the palette. A drawing is
 * an image and follows no theme of its own: under a theme that is light or
 * dark by name the colours are that palette's; under one that follows the
 * system (`auto`), the dark palette's, with the light one's wherever the
 * system is light.
 */
function inks(scheme: Scheme, classes: Readonly<Record<string, readonly ['stroke' | 'fill', Ink]>>): string {
  const rules = (isLight: boolean): string =>
    Object.entries(classes)
      .map(([name, [property, ink]]) => `.${name}{${property}:${palette(isLight)[ink]}}`)
      .join('')
  if (scheme !== 'auto') return `<style>${rules(scheme === 'light')}</style>`

  return `<style>${rules(false)}@media (prefers-color-scheme: light){${rules(true)}}</style>`
}

// What stands before a row that is a thing, not a status: lucide's Folder,
// File, Database, Terminal and Table, drawn as the navigation icons are.
const ROW_SHAPES = {
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  database:
    '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  // Terminal: a service the dashboard knows no mark for.
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  table: '<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
} as const

export type RowIcon = keyof typeof ROW_SHAPES

/** A row's icon as an SVG document, in the quiet ink. */
export function rowIcon(name: RowIcon, scheme: Scheme): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inks(scheme, { a: ['stroke', 'inkDim'] })}<g class="a">${ROW_SHAPES[name]}</g></svg>`
}

/** A tag's box, in pixels: two small letters, a little under a line of type. */
export const TAG_PX = { width: 18, height: 14 }

/**
 * A file's two-letter tag as a small drawing: a pane's own type has one size,
 * and a tag reads better set smaller than the name beside it. `tones` is its
 * colour on dark and on light; which one is used follows the theme as every
 * drawing here does.
 */
export function tagSvg(tag: string, tones: readonly [string, string], scheme: Scheme): string {
  const [dark, light] = tones
  const style =
    scheme === 'auto'
      ? `.a{fill:${dark}}@media (prefers-color-scheme: light){.a{fill:${light}}}`
      : `.a{fill:${scheme === 'light' ? light : dark}}`
  const letters = tag.replace(/[<>&]/g, '')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TAG_PX.width} ${TAG_PX.height}"><style>${style}</style><text class="a" x="0" y="11" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="10.5" font-weight="600">${letters}</text></svg>`
}

/** A view's icon as an SVG document, in the ink of the view in front or of one at rest. */
export function tabIcon(tab: Tab, ink: 'ink' | 'inkDim', scheme: Scheme): string {
  if (tab === 'linear') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inks(scheme, { a: ['fill', ink] })}<g class="a">${LINEAR}</g></svg>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inks(scheme, { a: ['stroke', ink] })}<g class="a">${SHAPES[tab]}</g></svg>`
}

/**
 * NoMoreIDE's mark (assets/nomoreide-logo.svg without its tile): a folder
 * with a prompt in it. The folder is ink, the prompt cut out of it paper.
 */
export function logo(scheme: Scheme): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="2 8 60 54">${inks(scheme, { a: ['fill', 'ink'], b: ['stroke', 'paper'] })}<path class="a" d="M5 17C5 13.69 7.69 11 11 11H25L31 17H53C56.31 17 59 19.69 59 23V53C59 56.31 56.31 59 53 59H11C7.69 59 5 56.31 5 53V17Z"/><path class="b" d="M22 31L30 39L22 47" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="4.5"/><path class="b" d="M36 47H48" fill="none" stroke-linecap="round" stroke-width="4.5"/></svg>`
}

/** A meter: a rounded track `width` by `height`, its first `filled` units inked, in `tone` where a status colours it. */
export function meterSvg(scheme: Scheme, width: number, height: number, filled: number, tone = ''): string {
  const bar = tone === '' ? 'class="b"' : `fill="${tone}"`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${inks(scheme, { a: ['fill', 'inkDim'], b: ['fill', 'ink'] })}<rect class="a" width="${width}" height="${height}" rx="${height / 2}" fill-opacity="0.28"/><rect ${bar} width="${filled}" height="${height}" rx="${height / 2}"/></svg>`
}

// A diff as a drawing, as a review on GitHub and the dashboard's Git page
// show one. A pane's own type has one face, and it is not a fixed-width one:
// code set in it loses its columns. Drawn, a diff has the face code is read
// in, both sides' line numbers, a faint green ground under a line added and a
// faint red one under a line removed, and the code's own colours on either.
// A file of no known language is two colours and no more: green and red type.
const DIFF = {
  /** One line's height and the type's size, in pixels. */
  line: 18,
  size: 12,
  /** A character's advance in the fixed-width faces named below, as a share of the size. */
  advance: 0.602,
  pad: 8,
  /** Lines in one drawing: a drawing's markup is held to a length. */
  chunk: 40,
} as const

// [on dark, on light]: plain type, the dim gutter, then each side's ground and type.
const DIFF_TONES = {
  t: ['#D4D4D4', '#000000'],
  d: ['#77756E', '#A3A19A'],
  ag: ['#11281B', '#ECFDF5'],
  at: ['#7EE2A8', '#166534'],
  rg: ['#2E1616', '#FEF2F2'],
  rt: ['#F8A3A3', '#C81E1E'],
  // The code's own parts, in the dashboard's colours for them
  // (apps/dashboard/src/features/git/file-viewer-theme.css), so a diff reads
  // the same in the pane as on its Git page.
  keyword: ['#569CD6', '#0000FF'],
  string: ['#CE9178', '#A31515'],
  comment: ['#6A9955', '#008000'],
  number: ['#B5CEA8', '#098658'],
  type: ['#4EC9B0', '#267F99'],
  call: ['#DCDCAA', '#795E26'],
} as const

const escaped = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\u0000-\u0008\u000b-\u001f]/g, '')

/**
 * A line cut into rows of at most `columns` characters, at a space or a mark
 * of punctuation where one falls in a row's last third, mid-word only where
 * none does.
 */
export function wrapLine(text: string, columns: number): string[] {
  const rows: string[] = []
  let rest = text
  while (rest.length > columns) {
    const window = rest.slice(0, columns)
    let cut = columns
    for (let at = columns - 1; at >= Math.floor((columns * 2) / 3); at -= 1) {
      if (/[\s,;:(){}[\].=]/.test(window[at] ?? '')) {
        cut = at + 1
        break
      }
    }
    rows.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  rows.push(rest)

  return rows
}

export type DiffDrawing = { source: string; width: number; height: number; alt: string }

/** A diff's rows as drawings `width` pixels across, a run of lines to each. */
export function diffSvgs(
  rows: readonly DiffRow[],
  scheme: Scheme,
  width: number,
  family: Family = 'other',
): DiffDrawing[] {
  const isColoured = isHighlighted(family)
  const step = DIFF.size * DIFF.advance
  const widthOf = (side: 'before' | 'after'): number =>
    String(Math.max(1, ...rows.map(one => one[side] ?? 0))).length
  const beforeEnd = DIFF.pad + widthOf('before') * step
  const afterEnd = beforeEnd + (1 + widthOf('after')) * step
  // The mark stands where a diff has it, in the column before the line's own first.
  const markAt = afterEnd + 2 * step
  const textAt = markAt + step
  const columns = Math.max(10, Math.floor((width - textAt - DIFF.pad) / step))
  const lines: string[] = []
  // A comment left open runs on down the lines of one side; each side keeps its own.
  const open = { before: false, after: false }
  for (const one of rows) {
    if (one.kind === 'hunk') {
      open.before = false
      open.after = false
      lines.push(`<text class="d" x="${DIFF.pad}" y="Y">${escaped(`⋯ ${one.text}`.slice(0, columns + 8))}</text>`)
      continue
    }
    const side = one.kind === 'added' ? 'a' : one.kind === 'removed' ? 'r' : ''
    const text = one.text.replace(/\t/g, '  ')
    const read = highlight(text, family, one.kind === 'removed' ? open.before : open.after)
    if (one.kind !== 'added') open.before = read.inBlock
    if (one.kind !== 'removed') open.after = read.inBlock
    let from = 0
    wrapLine(text, columns).forEach((part, at) => {
      const spans = sliceTokens(read.tokens, from, from + part.length)
        .map(token =>
          token.kind === 'plain' ? escaped(token.text) : `<tspan class="${token.kind}">${escaped(token.text)}</tspan>`,
        )
        .join('')
      from += part.length
      const ground = side === '' ? '' : `<rect class="${side}g" x="0" y="T" width="${width}" height="${DIFF.line}"/>`
      const gutter =
        at > 0
          ? ''
          : (one.before === null ? '' : `<text class="d" x="${beforeEnd}" y="Y" text-anchor="end">${one.before}</text>`) +
            (one.after === null ? '' : `<text class="d" x="${afterEnd}" y="Y" text-anchor="end">${one.after}</text>`) +
            (side === '' ? '' : `<text class="${side}t" x="${markAt}" y="Y">${side === 'a' ? '+' : '-'}</text>`)
      lines.push(
        `${ground}${gutter}<text class="${side === '' || isColoured ? 't' : `${side}t`}" x="${textAt}" y="Y" xml:space="preserve">${spans}</text>`,
      )
    })
  }
  const tone = (isLight: boolean): string =>
    Object.entries(DIFF_TONES)
      .map(([name, tones]) => `.${name}{fill:${tones[isLight ? 1 : 0]}}`)
      .join('')
  const style = `<style>.comment{font-style:italic}text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:${DIFF.size}px;white-space:pre}${
    scheme === 'auto' ? `${tone(false)}@media (prefers-color-scheme: light){${tone(true)}}` : tone(scheme === 'light')
  }</style>`
  const drawings: DiffDrawing[] = []
  for (let from = 0; from < lines.length; from += DIFF.chunk) {
    const some = lines.slice(from, from + DIFF.chunk)
    const height = some.length * DIFF.line
    const body = some
      .map((line, at) => line.replace(/y="Y"/g, `y="${at * DIFF.line + 13}"`).replace(/y="T"/g, `y="${at * DIFF.line}"`))
      .join('')
    drawings.push({
      source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${style}${body}</svg>`,
      width,
      height,
      alt: `diff, lines ${from + 1} to ${from + some.length} of ${lines.length}`,
    })
  }

  return drawings
}

// One line of `git log --graph` as a drawing: a pane's own type is not
// fixed-width, so the graph's characters would not line up as text. Each
// character is a cell: a commit a dot on its lane, the rest the lines that
// carry a lane down or across. A lane keeps one colour down the page.
const GRAPH_CELL = { width: 8, height: 19 }
const LANES = ['#4C9A8D', '#D97706', '#8B5CF6', '#0EA5E9', '#E11D48', '#059669'] as const

/** The pixels a graph line's drawing is wide. */
export const graphWidth = (graph: string): number => Math.max(1, graph.length) * GRAPH_CELL.width

/** `graph` (the characters git drew for one line) as an SVG; `isFirst` leaves the top of the first commit's lane open. */
export function graphSvg(graph: string, isFirst = false): string {
  const { width: w, height: h } = GRAPH_CELL
  const marks = [...graph].map((char, at) => {
    const x = at * w
    const mid = x + w / 2
    const ink = LANES[Math.floor(at / 2) % LANES.length] ?? LANES[0]
    const line = (x1: number, y1: number, x2: number, y2: number): string =>
      `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${ink}" stroke-width="1.5" stroke-linecap="round" fill="none"/>`
    if (char === '*') return `${line(mid, isFirst ? h / 2 : 0, mid, h)}<circle cx="${mid}" cy="${h / 2}" r="3.2" fill="${ink}"/>`
    if (char === '|') return line(mid, 0, mid, h)
    if (char === '/') return line(x + w + w / 2, 0, x - w / 2, h)
    if (char === '\\') return line(x - w / 2, 0, x + w + w / 2, h)
    if (char === '_' || char === '-') return line(x - w / 2, h, x + w + w / 2, h)

    return ''
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${graphWidth(graph)} ${h}">${marks.join('')}</svg>`
}

/** What a trend's axes say: three marks up each side (top, half, nought) and three along the foot (oldest, middle, now). */
export type TrendAxes = {
  left: readonly [string, string, string]
  /** A second scale, where the second series is not measured as the first is. */
  right?: readonly [string, string, string]
  foot: readonly [string, string, string]
}

/**
 * A trend as a drawing: each series a line over a plot with its axes marked,
 * its values set against its own `top`. Three faint rules stand at the top,
 * half and nought; the left marks say what they are for the first series, the
 * right for the second where it has a scale of its own; the foot says when.
 */
export function trendSvg(
  scheme: Scheme,
  series: readonly { values: readonly number[]; top: number; color: string }[],
  width: number,
  height: number,
  axes?: TrendAxes,
): string {
  const type = 9
  const left = axes === undefined ? 0 : 6 + Math.max(...axes.left.map(mark => mark.length)) * type * 0.56
  const right = axes?.right === undefined ? 2 : 6 + Math.max(...axes.right.map(mark => mark.length)) * type * 0.56
  const foot = axes === undefined ? 2 : type + 6
  const top = axes === undefined ? 2 : type / 2 + 1
  const plot = { x: left, y: top, w: Math.max(1, width - left - right), h: Math.max(1, height - top - foot) }
  const word = (text: string, x: number, y: number, anchor: string, fill = ''): string =>
    `<text ${fill === '' ? 'class="t"' : `fill="${fill}"`} x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="${type}">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`
  const rules = [0, 0.5, 1]
    .map((share, at) => {
      const y = plot.y + plot.h * share
      const marks =
        axes === undefined
          ? ''
          : word(axes.left[at] ?? '', plot.x - 4, y + type / 3, 'end', axes.right === undefined ? '' : series[0]?.color) +
            (axes.right === undefined ? '' : word(axes.right[at] ?? '', plot.x + plot.w + 4, y + type / 3, 'start', series[1]?.color))

      return `<path class="a" d="M${plot.x} ${y}H${plot.x + plot.w}" stroke-width="1" stroke-opacity="${share === 1 ? 0.6 : 0.25}" fill="none"/>${marks}`
    })
    .join('')
  const times =
    axes === undefined
      ? ''
      : word(axes.foot[0], plot.x, height - 2, 'start') +
        word(axes.foot[1], plot.x + plot.w / 2, height - 2, 'middle') +
        word(axes.foot[2], plot.x + plot.w, height - 2, 'end') +
        `<path class="a" d="M${plot.x} ${plot.y}V${plot.y + plot.h}" stroke-width="1" stroke-opacity="0.6" fill="none"/>`
  // Drawn last first, so the first series lies over the second.
  const lines = [...series]
    .reverse()
    .filter(one => one.values.length > 1)
    .map(one => {
      const ceiling = Math.max(one.top, 0.0001)
      const points = one.values.map((value, at) => {
        const x = plot.x + (at / (one.values.length - 1)) * plot.w
        const y = plot.y + plot.h * (1 - Math.max(0, Math.min(1, value / ceiling)))

        return `${x.toFixed(1)} ${y.toFixed(1)}`
      })

      return `<path d="M${points.join('L')}" stroke="${one.color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" fill="none"/>`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${inks(scheme, { a: ['stroke', 'inkDim'], t: ['fill', 'inkDim'] })}${rules}${times}${lines}</svg>`
}

// Output as a drawing, for the reason a diff is one: a pane's own type is not
// fixed-width, and a log is read in columns. Each line keeps its place and
// its spaces; a warning is amber and an error red on a faint red ground.
const LOG_TONES = {
  t: ['#D4D4D4', '#1F1F1F'],
  d: ['#77756E', '#A3A19A'],
  w: ['#E5B454', '#A16207'],
  b: ['#F8A3A3', '#C81E1E'],
  bg: ['#2E1616', '#FEF2F2'],
} as const

/** What a terminal paints with and a drawing cannot use: colour and cursor sequences. */
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g

/** Lines of output as drawings `width` pixels across, a run of lines to each, long lines broken. */
export function logSvgs(
  lines: readonly { text: string; tone: 'plain' | 'warn' | 'bad' }[],
  scheme: Scheme,
  width: number,
): DiffDrawing[] {
  const step = DIFF.size * DIFF.advance
  const columns = Math.max(10, Math.floor((width - DIFF.pad * 2) / step))
  const drawn: string[] = []
  for (const one of lines) {
    const text = one.text.replace(ANSI, '').replace(/\t/g, '  ').replace(/[\x00-\x1f]/g, '')
    const name = one.tone === 'bad' ? 'b' : one.tone === 'warn' ? 'w' : 't'
    for (const part of text === '' ? [''] : wrapLine(text, columns)) {
      const ground = one.tone === 'bad' ? `<rect class="bg" x="0" y="T" width="${width}" height="${DIFF.line}"/>` : ''
      drawn.push(`${ground}<text class="${name}" x="${DIFF.pad}" y="Y" xml:space="preserve">${escaped(part)}</text>`)
    }
  }
  const tone = (isLight: boolean): string =>
    Object.entries(LOG_TONES)
      .map(([name, tones]) => `.${name}{fill:${tones[isLight ? 1 : 0]}}`)
      .join('')
  const style = `<style>text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:${DIFF.size}px;white-space:pre}${
    scheme === 'auto' ? `${tone(false)}@media (prefers-color-scheme: light){${tone(true)}}` : tone(scheme === 'light')
  }</style>`
  const drawings: DiffDrawing[] = []
  for (let from = 0; from < drawn.length; from += DIFF.chunk) {
    const some = drawn.slice(from, from + DIFF.chunk)
    const height = some.length * DIFF.line
    const body = some
      .map((line, at) => line.replace(/y="Y"/g, `y="${at * DIFF.line + 13}"`).replace(/y="T"/g, `y="${at * DIFF.line}"`))
      .join('')
    drawings.push({
      source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${style}${body}</svg>`,
      width,
      height,
      alt: some.length === 0 ? 'output' : `output, lines ${from + 1} to ${from + some.length} of ${drawn.length}`,
    })
  }

  return drawings
}

// The lyric of an opened now-playing card as a drawing: a pane's own type has
// one size, and a lyric read from across a desk wants a larger one with air
// between its lines. The line being sung is bold, in full ink: that is mark enough.
export const LYRIC = { size: 16, line: 30 } as const

/** How many pixels `text` takes at the lyric's size: a wide character a whole em, the rest about half. */
const lyricWidth = (text: string): number =>
  [...text].reduce((sum, char) => sum + (/[\u1100-\uffef]/.test(char) ? LYRIC.size : LYRIC.size * 0.56), 0)

/** `text` cut to `room` pixels, with a mark that it goes on. */
function lyricFit(text: string, room: number): string {
  if (lyricWidth(text) <= room) return text
  let kept = ''
  for (const char of text) {
    if (lyricWidth(`${kept}${char}…`) > room) break
    kept += char
  }

  return `${kept}…`
}

/** Lyric lines as one drawing `width` pixels across; `now` is the place of the line being sung, -1 for none. */
export function lyricSvg(scheme: Scheme, lines: readonly string[], now: number, width: number): string {
  const body = lines
    .map((text, at) => {
      const y = at * LYRIC.line + LYRIC.line * 0.68
      const isNow = at === now

      return `<text class="${isNow ? 'b' : 'a'}" x="0" y="${y}"${isNow ? ' font-weight="700"' : ''}>${escaped(lyricFit(text, width))}</text>`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${Math.max(1, lines.length) * LYRIC.line}"><style>text{font-family:system-ui,-apple-system,"PingFang SC","Helvetica Neue",sans-serif;font-size:${LYRIC.size}px}</style>${inks(scheme, { a: ['fill', 'inkDim'], b: ['fill', 'ink'] })}${body}</svg>`
}
