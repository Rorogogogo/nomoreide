import type { Color, RenderElement } from 'claude-code'

import type { Limit } from '../../types'
import { plural } from '../text'
import { meterSvg } from '../icons'
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
export function meter(kit: Kit, m: Model, share: number, what: string): RenderElement {
  const { Text, Svg } = kit
  const part = Math.max(0, Math.min(1, share))
  if (Svg === undefined) {
    const full = Math.round(part * BAR_CELLS)

    return (
      <kit.Box flexShrink={0}>
        <Text dimColor>{'█'.repeat(full) + '░'.repeat(BAR_CELLS - full)}</Text>
      </kit.Box>
    )
  }
  const { width, height } = METER_PX
  const filled = part === 0 ? 0 : Math.max(height, Math.round(part * width))

  return (
    <Svg
      source={meterSvg(m.scheme, width, height, filled)}
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
        {isBeside && meter(kit, m, share, label)}
        <Box flexGrow={1} />
        <Box flexShrink={0} marginLeft={1}>
          <Text bold {...(tone === undefined ? {} : { color: tone })}>
            {value}
          </Text>
        </Box>
      </Box>
      {!isBeside && (
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          {meter(kit, m, share, label)}
          <Text dimColor wrap="truncate-end">
            {note}
          </Text>
        </Box>
      )}
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
