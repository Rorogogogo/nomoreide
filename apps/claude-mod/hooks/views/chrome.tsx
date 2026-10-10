import type { Color, RenderElement } from 'claude-code'

import type { LogLine, Notice, Service } from '../../types'
import { familyOf } from '../files'
import { diffRows } from '../git'
import { clipEnd } from '../text'
import { TAG_PX, diffSvgs, logSvgs, rowIcon, tagSvg } from '../icons'
import type { RowIcon } from '../icons'
import { FAMILY_TONE, GLYPH } from '../tokens'
import type { Palette } from '../tokens'
import type { Actions, Kit, Model } from './model'

// The look is the dashboard's (docs/DESIGN.md), carried over as far as a pane
// allows. The row is the atom: a status mark, a title that takes the press,
// one dim meta line of `identifier · context`, and a quiet accessory at the
// far end. The view in front is foreground on background, as `TabStrip`
// selects. Saturated colour is status and nothing else. Sections are a small
// uppercase label, never a box.
//
// A pane is a terminal's sixty-odd cells or a desktop sidebar of thirty, set
// in one font or another, so nothing here is laid out by counting characters
// alone: a row is a mark column beside a column that shrinks, and its text is
// left to the surface to cut where the surface can.

/** How many rows of one list are drawn before the rest is counted. */
export const MAX_ROWS = 200

/** Below this many cells a pane is a sidebar: fewer words on a line, no second thoughts. */
export const NARROW = 44

/** Below this many cells five tabs with their icons want every cell: no air between, no quiet counts. */
export const TIGHT = 64

/** The cells a card's outline and padding take from a row on a cell grid. */
export const CARD = 4

/** Off a cell grid a press is drawn with half a cell of room each side; what sits under one is set in as far. */
export const PRESS_INSET = 0.5

/** A navigation icon's side, in pixels: a line of the surface's type is seventeen tall. */
/** The status mark's column off a cell grid, in cells: the mark and its gap. */
export const MARK_COLUMN = 2.5

/**
 * How an action is drawn: a dim word on a cell grid, where a bracket per row
 * is noise; the surface's own button anywhere that has one.
 */
export const chip = (m: Model, isDim = true): { plain?: true; dimColor?: boolean } =>
  m.isTerminal ? { plain: true, dimColor: isDim } : {}

// A fill under the pointer is a square on any surface. A cell grid is all
// squares; elsewhere the surface rounds its own hover on the name, so the
// row adds none of its own.
export const rowHover = (m: Model): { hover?: { backgroundColor: Color } } =>
  m.isTerminal ? { hover: { backgroundColor: m.colors.hover } } : {}

export const paint = (color: Color | undefined): { color: Color } | { dimColor: true } =>
  color === undefined ? { dimColor: true } : { color }

export const isLive = (service: Service): boolean =>
  service.state === 'running' ||
  service.state === 'starting' ||
  service.state === 'stopping'

export const hasFailed = (service: Service): boolean =>
  service.state === 'exited' && service.exitCode !== null && service.exitCode !== 0

/**
 * A label a press rides on, cut to the room left of `reserved` cells. A cell
 * is a character on a terminal; set proportionally, a line holds about a
 * fifth more characters than cells, so the cut is that much later.
 */
export function fit(m: Model, text: string, reserved: number): string {
  const cells = Math.max(6, m.width - reserved - (m.isTerminal ? CARD : 0))

  return clipEnd(text, m.isTerminal ? cells : Math.floor(cells * 1.2))
}

export const space = (kit: Kit): RenderElement => <kit.Box height={1} flexShrink={0} />

// A hairline is a row of box-drawing cells, which only a cell grid lines up.
// Where type is set proportionally the same break is a row of air.
export const rule = (kit: Kit, m: Model): RenderElement =>
  m.isTerminal ? (
    <kit.Text color={m.colors.rule}>{GLYPH.rule.repeat(Math.max(1, m.width))}</kit.Text>
  ) : (
    space(kit)
  )

export function noticeRow(kit: Kit, m: Model, notice: Notice): RenderElement {
  const { Box, Text } = kit

  return (
    <Box flexDirection="row" marginBottom={1}>
      <Text color={notice.tone === 'ok' ? m.colors.ok : m.colors.bad}>{GLYPH.bar}</Text>
      <Box flexShrink={1} minWidth={0}>
        <Text>{notice.text}</Text>
      </Box>
    </Box>
  )
}

/**
 * A view's own views, one in front: the surface's chip for it off a cell
 * grid, a bold underlined word on one; the others are quiet words to press.
 */
export function strip<T extends string>(
  kit: Kit,
  m: Model,
  items: readonly { id: T; hotkey: string; label: string }[],
  front: T,
  go: (id: T) => Promise<void>,
): RenderElement {
  const { Box, Text, Button } = kit

  return (
    <Box flexDirection="row" alignItems="center" columnGap={m.isTerminal ? 3 : 1}>
      {items.map(one =>
        one.id === front && m.isTerminal ? (
          <Text bold underline>
            {one.label}
          </Text>
        ) : (
          <Button
            key={`section-${one.id}`}
            {...(one.id === front ? {} : { plain: true as const, dimColor: true })}
            {...(m.isTerminal ? { hotkey: one.hotkey } : {})}
            label={one.label}
            onPress={() => go(one.id)}
          />
        ),
      )}
    </Box>
  )
}

/** A cell's width off a cell grid, in pixels, as measured in the desktop app. */
const CELL_PX = 8
/** A row icon's side off a cell grid, in pixels, and the column it stands in, in cells. */
const ROW_ICON_PX = 14
const ROW_ICON_COLUMN = 2.5

/**
 * What a row is, before its name, in a column of its own so names start
 * level. A file is told by a two-letter tag coloured by its family: plain
 * letters on a cell grid, a small drawing where a surface draws pictures,
 * set smaller than the name beside it. Anything else is the dashboard's icon
 * there, and a quiet mark on a cell grid.
 */
export function kind(kit: Kit, m: Model, name: RowIcon, file?: { tag: string; family: string }): RenderElement {
  const { Box, Text, Svg } = kit
  const tones = FAMILY_TONE[file?.family ?? 'other'] ?? ['#71717A', '#71717A']
  if (Svg === undefined) {
    return (
      <Box flexShrink={0} width={3}>
        <Text color={file === undefined ? m.colors.inert : tones[m.scheme === 'light' ? 1 : 0]}>
          {file?.tag ?? GLYPH[name]}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexShrink={0} width={ROW_ICON_COLUMN} flexDirection="row" alignItems="center">
      {file === undefined ? (
        <Svg source={rowIcon(name, m.scheme)} alt={name} width={ROW_ICON_PX} height={ROW_ICON_PX} />
      ) : (
        <Svg source={tagSvg(file.tag, tones, m.scheme)} alt={`${file.tag} file`} width={TAG_PX.width} height={TAG_PX.height} />
      )}
    </Box>
  )
}

/** A file's git letter at the far end of its row, in the status colour, as the Changes list shows it. */
export function gitLetter(kit: Kit, m: Model, code: string): RenderElement | false {
  return (
    code !== '' && (
      <kit.Box flexShrink={0} marginLeft={1}>
        <kit.Text bold color={toneOf(code, m.colors)}>
          {code}
        </kit.Text>
      </kit.Box>
    )
  )
}

/** Leading spaces as ones a surface that sets type keeps: plain ones are folded away there. */
export const indented = (line: string): string =>
  line.replace(/^[ \t]+/, lead => lead.replace(/\t/g, '  ').replace(/ /g, ' '))

/**
 * A diff. A cell grid has the engine's own drawing of one, added and removed
 * lines on their coloured grounds. Off a cell grid that drawing colours the
 * type alone, and a pane's own type is not fixed-width: there the diff is a
 * drawing, as a review on GitHub shows one: code in the face it is read in
 * and in its own colours, a line added on a faint green ground and a line
 * removed on a faint red one. A surface with no pictures gets the lines as
 * text on the theme's grounds.
 */
/** What a terminal paints with and a line of text should not carry: colour and cursor sequences. */
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g

/** A line of an error's excerpt read for its tone, as the daemon tones a service's output. */
export function toneOfLine(text: string): LogLine['tone'] {
  if (/\b(error|panic(ked)?|fatal|exception|failed|failure|errno|traceback)\b/i.test(text)) return 'bad'

  return /\bwarn(ing)?\b/i.test(text) ? 'warn' : 'plain'
}

/**
 * Output as it is read in a terminal: a fixed-width face, every space kept,
 * a warning amber and an error red. A drawing in a card where a surface
 * draws pictures, as a diff is; plain coloured lines on a cell grid.
 */
export function logBody(kit: Kit, m: Model, lines: readonly LogLine[]): RenderElement {
  const { Box, Text, Svg } = kit
  if (Svg !== undefined && !m.isTerminal) {
    const width = Math.max(160, Math.round((m.width - 1) * CELL_PX))

    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor marginTop={1} paddingY={0.5}>
        {logSvgs(lines, m.scheme, width).map((one, at) => (
          <Svg key={`log:${at}`} source={one.source} alt={one.alt} width={one.width} />
        ))}
      </Box>
    )
  }

  // On a cell grid: the same card, each line behind a gutter that marks a
  // warning amber and an error red, so they are found without reading.
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      {lines.map((line, at) => {
        const text = line.text.replace(ANSI, '').replace(/\t/g, '  ')
        const tone = line.tone === 'bad' ? m.colors.bad : line.tone === 'warn' ? m.colors.busy : undefined

        return (
          <Box key={`log:${at}`} flexDirection="row" alignItems="flex-start">
            <Box flexShrink={0} width={2}>
              {tone === undefined ? <Text> </Text> : <Text color={tone}>{GLYPH.bar}</Text>}
            </Box>
            <Box flexShrink={1} minWidth={0}>
              <Text {...(tone === undefined ? {} : { color: tone })}>{text === '' ? ' ' : text}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

export function diffBody(kit: Kit, m: Model, hunks: string, path: string): RenderElement {
  const { Box, Text, Code } = kit
  if (m.isTerminal) return <Code source={hunks} format="diff" path={path} />
  const { Svg } = kit
  const rows = diffRows(hunks)
  if (Svg !== undefined) {
    // The card's outline and the air inside it are taken from the room, a cell being eight pixels.
    const width = Math.max(160, Math.round((m.width - 1) * CELL_PX))

    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor marginTop={1}>
        {diffSvgs(rows, m.scheme, width, familyOf(path)).map((one, at) => (
          // No height: the surface fits the drawing to the room across and keeps its shape.
          <Svg key={`diff:${at}`} source={one.source} alt={one.alt} width={one.width} />
        ))}
      </Box>
    )
  }
  const digits = String(Math.max(1, ...rows.map(one => one.after ?? one.before ?? 0))).length

  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor marginTop={1} paddingY={0.5}>
      {rows.map((one, at) =>
        one.kind === 'hunk' ? (
          <Box key={`diff:${at}`} paddingX={1} marginTop={at === 0 ? 0 : 0.5}>
            <Text dimColor wrap="truncate-end">
              {one.text === '' ? '⋯' : `⋯ ${one.text}`}
            </Text>
          </Box>
        ) : (
          <Box
            key={`diff:${at}`}
            flexDirection="row"
            alignItems="flex-start"
            paddingX={1}
            {...(one.kind === 'added'
              ? { backgroundColor: 'diffAddedDimmed' as const }
              : one.kind === 'removed'
                ? { backgroundColor: 'diffRemovedDimmed' as const }
                : {})}
          >
            <Box flexShrink={0} width={digits + 1.5}>
              <Text dimColor>{String(one.after ?? one.before ?? '')}</Text>
            </Box>
            <Box flexShrink={0} width={1.5}>
              <Text dimColor>{one.kind === 'added' ? '+' : one.kind === 'removed' ? GLYPH.remove : ' '}</Text>
            </Box>
            <Box flexShrink={1} minWidth={0}>
              <Text>{indented(one.text) || ' '}</Text>
            </Box>
          </Box>
        ),
      )}
    </Box>
  )
}

/**
 * A press that hands something to Claude: one look everywhere, so what goes
 * to the prompt box is told at a glance from what the pane does itself.
 */
export function ask(kit: Kit, m: Model, act: Actions, key: string, label: string, text: () => string): RenderElement {
  return <kit.Button key={key} {...chip(m, false)} label={`${GLYPH.ask} ${label}`} onPress={() => act.draft(text())} />
}

/** An uppercase label and its count: the only heading a list gets. */
export function heading(kit: Kit, label: string, count?: number, action?: RenderElement): RenderElement {
  const { Box, Text } = kit

  return (
    <Box flexDirection="row">
      <Text dimColor bold>
        {label}
      </Text>
      {count !== undefined && <Text dimColor>  {count}</Text>}
      <Box flexGrow={1} />
      {action}
    </Box>
  )
}

/**
 * The row, DESIGN.md's atom: a status mark in a column of its own, so the two
 * lines beside it start level in any font; a title; an accessory pushed to
 * the far end; one dim meta line the surface cuts at the edge.
 */
export function row(
  kit: Kit,
  m: Model,
  key: string,
  mark: { glyph: string; color: Color },
  title: RenderElement,
  accessory: RenderElement | false | undefined,
  meta: string,
  isPress = true,
): RenderElement {
  const { Box, Text } = kit
  // Off a cell grid a line with buttons on it is taller than a line of type,
  // so the mark rides on the title's own line, centred with it, in a column
  // of fixed width that the meta line is then set in by.
  if (!m.isTerminal) {
    return (
      <Box key={key} flexDirection="column">
        <Box flexDirection="row" alignItems="center">
          <Box flexShrink={0} width={MARK_COLUMN}>
            <Text color={mark.color}>{mark.glyph}</Text>
          </Box>
          <Box flexShrink={1} minWidth={0}>
            {title}
          </Box>
          <Box flexGrow={1} />
          {accessory !== false && accessory !== undefined && (
            <Box flexShrink={0} flexDirection="row" alignItems="center" marginLeft={1}>
              {accessory}
            </Box>
          )}
        </Box>
        {meta !== '' && (
          <Box paddingLeft={MARK_COLUMN + (isPress ? PRESS_INSET : 0)}>
            <Text dimColor wrap="truncate-end">
              {clipEnd(meta, 160)}
            </Text>
          </Box>
        )}
      </Box>
    )
  }

  return (
    <Box
      key={key}
      flexDirection="row"
      alignItems="flex-start"
      {...rowHover(m)}
    >
      <Box flexShrink={0} marginRight={1}>
        <Text color={mark.color}>{mark.glyph}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        <Box flexDirection="row">
          <Box flexShrink={1} minWidth={0}>
            {title}
          </Box>
          <Box flexGrow={1} />
          {accessory !== false && accessory !== undefined && (
            <Box flexShrink={0} flexDirection="row" marginLeft={1}>
              {accessory}
            </Box>
          )}
        </Box>
        {meta !== '' && (
          <Box paddingLeft={m.isTerminal || !isPress ? 0 : PRESS_INSET}>
            <Text dimColor wrap="truncate-end">
              {m.isTerminal ? clipEnd(meta, m.width - 2 - CARD) : clipEnd(meta, 160)}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}

/**
 * A list's rows, in one rounded card with a faint outline: box-drawing
 * corners on a cell grid, the surface's own card elsewhere.
 */
export function group(kit: Kit, m: Model, rows: readonly (RenderElement | false)[], gap = 1): RenderElement {
  const { Box } = kit

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderDimColor
      paddingX={1}
      marginTop={m.isTerminal ? 0 : 1}
      rowGap={gap}
    >
      {rows}
    </Box>
  )
}

/** A view with nothing in it: said once, in the middle, and left alone. */
export function quiet(kit: Kit, m: Model, glyph: string, title: string, hint: string): RenderElement {
  const { Box, Text } = kit

  return (
    <Box flexDirection="column" alignItems="center" paddingY={2}>
      <Text color={m.colors.inert}>{glyph}</Text>
      <Text>{title}</Text>
      <Text dimColor>{hint}</Text>
    </Box>
  )
}

export function offline(kit: Kit, m: Model): RenderElement {
  return m.reach === 'unknown'
    ? quiet(kit, m, GLYPH.off, 'Looking for NoMoreIDE', 'One moment.')
    : quiet(
        kit,
        m,
        GLYPH.off,
        'NoMoreIDE is not running',
        'Start the app or its daemon and this fills in.',
      )
}

export function more(kit: Kit, hidden: number, what: string): RenderElement | false {
  return hidden > 0 && <kit.Text dimColor>… {hidden} more {what}</kit.Text>
}

/** A status letter's colour: added, removed, in conflict, untracked, modified. */
export function toneOf(code: string, colors: Palette): Color {
  if (code === 'A') return colors.ok
  if (code === 'D' || code === 'U') return colors.bad
  if (code === '?') return colors.inert

  return colors.busy
}

/**
 * A status letter in a column of its own: a cell on a grid; where type is
 * set proportionally, a fixed width, so an `M` and an `A` start their names level.
 */
export function letter(kit: Kit, m: Model, code: string): RenderElement {
  const { Box, Text } = kit

  return (
    <Box flexShrink={0} {...(m.isTerminal ? { marginRight: 1 } : { width: 2 })}>
      <Text bold color={toneOf(code, m.colors)}>
        {code}
      </Text>
    </Box>
  )
}

/**
 * A press that puts files back, taken in two: the first asks, the second
 * does. What it would overwrite is the person's working tree.
 */
export function twice(kit: Kit, m: Model, act: Actions, key: string, label: string, run: () => Promise<void>): RenderElement {
  const { Box, Button } = kit
  if (m.confirming !== key) {
    return <Button key={key} {...chip(m)} label={label} onPress={() => act.ask(key)} />
  }

  return (
    <Box flexDirection="row" columnGap={m.width < NARROW ? 1 : 2}>
      <Button key={`yes:${key}`} {...chip(m, false)} label={`${label} now`} onPress={run} />
      <Button key={`no:${key}`} {...chip(m)} label="cancel" onPress={() => act.cancel()} />
    </Box>
  )
}

export const repoNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
