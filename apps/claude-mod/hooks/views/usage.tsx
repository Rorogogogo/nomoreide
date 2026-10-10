import type { Color, RenderElement } from 'claude-code'

import type { Limit, Trend } from '../../types'
import { plural } from '../text'
import { meterSvg, trendSvg } from '../icons'
import { GLYPH } from '../tokens'
import { group, heading, quiet, space } from './chrome'
import type { Kit, Model } from './model'

/** A figure and what it is of: the label, the value at the far end, a dim line under. */
export function stat(kit: Kit, m: Model, key: string, label: string, value: string, meta = '', tone?: Color): RenderElement {
  const { Box, Text } = kit

  return (
    <Box key={key} flexDirection="column">
      <Box flexDirection="row">
        <Box flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end">{label}</Text>
        </Box>
        <Box flexGrow={1} />
        <Box flexShrink={0} marginLeft={1}>
          <Text bold {...(tone === undefined ? {} : { color: tone })}>
            {value}
          </Text>
        </Box>
      </Box>
      {meta !== '' && (
        <Text dimColor wrap="truncate-end">
          {meta}
        </Text>
      )}
    </Box>
  )
}

export const money = (usd: number): string => `$${usd.toFixed(2)}`

export function count(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`

  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value)
}

/** How long until an epoch-millisecond moment, in the one unit that fits. */
export function until(now: number, at: number): string {
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)

  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

export const BAR_CELLS = 12

/** The column a day's date stands in, so the meters beside start level in any font. */
export const DAY_COLUMN = 6

/** A drawn meter's size, in pixels: a hair under a line of type, as long as twelve cells. */
export const METER_PX = { width: 96, height: 6 }

/**
 * A share of a whole as a meter: block cells on a grid; where a surface
 * draws pictures, a rounded track with its filled part, as it rounds all else.
 */
export function meter(kit: Kit, m: Model, share: number, what: string, tone?: Color): RenderElement {
  const { Text, Svg } = kit
  const part = Math.max(0, Math.min(1, share))
  if (Svg === undefined) {
    const full = Math.round(part * BAR_CELLS)

    return (
      // The band's meter: a thin rule, inked for the part used and faint for the rest.
      <kit.Box flexShrink={0} flexDirection="row">
        <Text {...(tone === undefined ? {} : { color: tone })}>{GLYPH.meter.repeat(full)}</Text>
        <Text color={m.colors.rule}>{GLYPH.meter.repeat(BAR_CELLS - full)}</Text>
      </kit.Box>
    )
  }
  const { width, height } = METER_PX
  const filled = part === 0 ? 0 : Math.max(height, Math.round(part * width))

  return (
    <Svg
      source={meterSvg(m.scheme, width, height, filled, typeof tone === 'string' ? tone : '')}
      alt={`${what}: ${Math.round(part * 100)}%`}
      width={width}
      height={height}
    />
  )
}

/** A figure with a meter under or beside its label. */
export function metered(
  kit: Kit,
  m: Model,
  key: string,
  label: string,
  value: string,
  share: number,
  note: string,
  tone?: Color,
): RenderElement {
  const { Box, Text } = kit
  const isBeside = note === ''

  return (
    <Box key={key} flexDirection="column">
      <Box flexDirection="row" alignItems="center" columnGap={isBeside ? 1 : 0}>
        <Box flexShrink={0} {...(isBeside ? { width: DAY_COLUMN } : {})}>
          <Text>{label}</Text>
        </Box>
        {isBeside && meter(kit, m, share, label, tone)}
        <Box flexGrow={1} />
        <Box flexShrink={0} marginLeft={1}>
          <Text bold {...(tone === undefined ? {} : { color: tone })}>
            {value}
          </Text>
        </Box>
      </Box>
      {!isBeside && (
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          {meter(kit, m, share, label, tone)}
          <Text dimColor wrap="truncate-end">
            {note}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/** The second line a trend draws: sky, as the dashboard's memory line; the first is the palette's emerald. */
const SKY = '#0EA5E9'

const SPARKS = '▁▂▃▄▅▆▇█'

/** `values` as one row of block characters, each against `top`. */
export function spark(values: readonly number[], top: number): string {
  return values
    .map(value => SPARKS[Math.round(Math.max(0, Math.min(1, value / Math.max(top, 0.0001))) * (SPARKS.length - 1))] ?? ' ')
    .join('')
}

/** The rows a plot on a cell grid stands: four dots down to a row, so twenty steps of height. */
const PLOT_ROWS = 5

// A braille cell's dots, by column then row from the top.
const DOT = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
] as const

type Cell = { bits: number; owner: number }

/**
 * Series as lines of braille dots on a grid `columns` by `rows` cells: each
 * value set against its series' `top`, consecutive points joined so the line
 * does not break where it climbs. A cell is owned by the first series to
 * mark it (1, 2, ...), which is the colour it is drawn in; 0 for an empty one.
 */
export function plot(series: readonly { values: readonly number[]; top: number }[], columns: number, rows: number): Cell[][] {
  const grid: Cell[][] = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ({ bits: 0, owner: 0 })))
  const wide = columns * 2
  const tall = rows * 4
  const dot = (x: number, y: number, owner: number): void => {
    const cell = grid[Math.floor(y / 4)]?.[Math.floor(x / 2)]
    if (cell === undefined) return
    cell.bits |= DOT[x % 2]?.[y % 4] ?? 0
    if (cell.owner === 0) cell.owner = owner
  }
  series.forEach((one, index) => {
    if (one.values.length < 2) return
    const ceiling = Math.max(one.top, 0.0001)
    let before: number | undefined
    for (let x = 0; x < wide; x += 1) {
      // The value at this dot, read between the two samples either side of it.
      const at = (x / (wide - 1)) * (one.values.length - 1)
      const low = one.values[Math.floor(at)] ?? 0
      const high = one.values[Math.ceil(at)] ?? low
      const value = low + (high - low) * (at - Math.floor(at))
      const y = Math.round((1 - Math.max(0, Math.min(1, value / ceiling))) * (tall - 1))
      const from = before === undefined ? y : Math.min(before, y)
      const to = before === undefined ? y : Math.max(before, y)
      for (let step = from; step <= to; step += 1) dot(x, step, index + 1)
      before = y
    }
  })

  return grid
}

/** A row of plot cells as runs of one owner each, so a run is drawn in one colour. */
export function runs(row: readonly Cell[]): { owner: number; text: string }[] {
  const out: { owner: number; text: string }[] = []
  for (const cell of row) {
    const char = cell.bits === 0 ? ' ' : String.fromCharCode(0x2800 + cell.bits)
    const last = out[out.length - 1]
    if (last !== undefined && last.owner === cell.owner) last.text += char
    else out.push({ owner: cell.owner, text: char })
  }

  return out
}

/** How long a trend covers, in the one unit that fits. */
const span = (seconds: number): string => (seconds >= 120 ? `${Math.round(seconds / 60)}m` : `${seconds}s`)

/**
 * Two measures over time, as the dashboard's history chart: lines where a
 * surface draws pictures, a row of blocks each on a cell grid. Each line is
 * set against its own `top`, and the legend under says what each stands at.
 */
export function trendChart(
  kit: Kit,
  m: Model,
  key: string,
  trend: Trend,
  cpu: { label: string; top: number; now: string; unit: (value: number) => string },
  memory: { label: string; top: number; now: string; unit: (value: number) => string },
): RenderElement {
  const { Box, Text, Svg } = kit
  // The card's outline and the air inside it are taken from the room.
  const cells = Math.max(16, m.width - 4)
  const legend = (
    <Box flexDirection="row" columnGap={2}>
      <Box flexDirection="row" flexShrink={0}>
        <Text color={m.colors.ok}>{GLYPH.on} </Text>
        <Text dimColor>
          {cpu.label} {cpu.now}
        </Text>
      </Box>
      <Box flexDirection="row" flexShrink={0}>
        <Text color={SKY}>{GLYPH.on} </Text>
        <Text dimColor>
          {memory.label} {memory.now}
        </Text>
      </Box>
      <Box flexGrow={1} />
      <Text dimColor>last {span(trend.seconds)}</Text>
    </Box>
  )
  const marks = (one: { top: number; unit: (value: number) => string }): readonly [string, string, string] => [
    one.unit(one.top),
    one.unit(one.top / 2),
    one.unit(0),
  ]
  const ago = (seconds: number): string => (seconds <= 0 ? 'now' : `${span(seconds)} ago`)
  const foot = [ago(trend.seconds), ago(Math.round(trend.seconds / 2)), 'now'] as const
  // One scale serves both lines when they are measured alike; else each side has its own.
  const isShared = cpu.unit(cpu.top) === memory.unit(memory.top)
  if (Svg === undefined) {
    // A line plot in braille dots, two across and four down to a cell, with
    // the first measure's marks up the left and the second's up the right.
    const leftMarks = marks(cpu)
    const rightMarks = isShared ? (['', '', ''] as const) : marks(memory)
    const leftWide = Math.max(...leftMarks.map(mark => mark.length))
    const rightWide = Math.max(...rightMarks.map(mark => mark.length))
    const columns = Math.max(8, cells - leftWide - rightWide - (rightWide > 0 ? 4 : 2))
    const grid = plot(
      [
        { values: trend.cpu, top: cpu.top },
        { values: trend.memory, top: memory.top },
      ],
      columns,
      PLOT_ROWS,
    )
    const inkOf = (owner: number): Color | undefined => (owner === 1 ? m.colors.ok : owner === 2 ? SKY : undefined)
    const middle = Math.floor(PLOT_ROWS / 2)
    const markAt = (row: number, three: readonly [string, string, string]): string =>
      row === 0 ? three[0] : row === middle ? three[1] : row === PLOT_ROWS - 1 ? three[2] : ''
    const start = ago(trend.seconds)

    return (
      <Box key={key} flexDirection="column">
        {grid.map((cellsOfRow, row) => (
          <Box key={`${key}:${row}`} flexDirection="row">
            <Text color={m.colors.ok}>{markAt(row, leftMarks).padStart(leftWide)}</Text>
            <Text color={m.colors.rule}> {row === PLOT_ROWS - 1 ? '┴' : '┤'}</Text>
            {runs(cellsOfRow).map((run, at) => {
              const ink = inkOf(run.owner)

              return (
                <Text key={`${key}:${row}:${at}`} {...(ink === undefined ? { color: m.colors.rule } : { color: ink })}>
                  {run.text}
                </Text>
              )
            })}
            {rightWide > 0 && <Text color={m.colors.rule}>{row === PLOT_ROWS - 1 ? '┴' : '├'} </Text>}
            {rightWide > 0 && <Text color={SKY}>{markAt(row, rightMarks)}</Text>}
          </Box>
        ))}
        <Text dimColor>{`${' '.repeat(leftWide + 2)}${start}${' '.repeat(Math.max(1, columns - start.length - 3))}now`}</Text>
        {legend}
      </Box>
    )
  }
  const width = cells * 8
  const height = 96

  return (
    <Box key={key} flexDirection="column" rowGap={0.5}>
      <Svg
        source={trendSvg(
          m.scheme,
          [
            { values: trend.cpu, top: cpu.top, color: m.colors.ok },
            { values: trend.memory, top: memory.top, color: SKY },
          ],
          width,
          height,
          isShared ? { left: marks(cpu), foot } : { left: marks(cpu), right: marks(memory), foot },
        )}
        alt={`${cpu.label} ${cpu.now} and ${memory.label} ${memory.now} over the last ${span(trend.seconds)}`}
        width={width}
      />
      {legend}
    </Box>
  )
}

export function limitStat(kit: Kit, m: Model, key: string, label: string, limit: Limit): RenderElement {
  const tone = limit.usedPercent >= 90 ? m.colors.bad : limit.usedPercent >= 70 ? m.colors.busy : m.colors.ok
  const resets = limit.resetsAt > m.now ? `resets in ${until(m.now, limit.resetsAt)}` : 'of the limit used'

  return metered(kit, m, key, label, `${limit.usedPercent}%`, limit.usedPercent / 100, resets, tone)
}

export function usageView(kit: Kit, m: Model): RenderElement {
  const { Box } = kit
  const usage = m.usage
  if (usage === null) return quiet(kit, m, GLYPH.off, 'Reading usage', 'One moment.')
  const { session, period } = usage
  const hasLimits = usage.fiveHour !== null || usage.weekly !== null
  if (!hasLimits && session === null && (period === null || (period.runs === 0 && period.codexTokens === 0))) {
    return quiet(kit, m, GLYPH.off, 'No usage recorded yet', 'What agent runs cost is kept here as they happen.')
  }
  const top = Math.max(0.01, ...(period?.days.map(day => day.costUSD) ?? []))

  return (
    <Box flexDirection="column">
      {hasLimits && heading(kit, 'CLAUDE LIMITS')}
      {hasLimits &&
        group(kit, m, [
          usage.fiveHour !== null && limitStat(kit, m, 'stat:five', '5-hour window', usage.fiveHour),
          usage.weekly !== null && limitStat(kit, m, 'stat:week', 'This week', usage.weekly),
        ])}
      {hasLimits && session !== null && space(kit)}
      {session !== null && heading(kit, 'LATEST SESSION')}
      {session !== null &&
        group(kit, m, [
          stat(
            kit,
            m,
            'stat:session',
            'Cost',
            money(session.costUSD),
            `+${session.linesAdded} ${GLYPH.remove}${session.linesRemoved} lines`,
          ),
        ])}
      {period !== null && (hasLimits || session !== null) && space(kit)}
      {period !== null && heading(kit, 'LAST 30 DAYS')}
      {period !== null &&
        group(kit, m, [
          stat(kit, m, 'stat:cost', 'Total cost', money(period.costUSD), `${plural(period.runs, 'run')} ${GLYPH.dot} ${count(period.tokens)} tokens`),
          period.codexTokens > 0 && stat(kit, m, 'stat:codex', 'Codex tokens', count(period.codexTokens)),
        ])}
      {period !== null && period.days.length > 0 && space(kit)}
      {period !== null && period.days.length > 0 && heading(kit, 'COST BY DAY')}
      {period !== null &&
        period.days.length > 0 &&
        group(kit, m, period.days.map(day =>
          metered(kit, m, `stat:day:${day.date}`, day.date.slice(5), money(day.costUSD), day.costUSD / top, ''),
        ), 0)}
    </Box>
  )
}
