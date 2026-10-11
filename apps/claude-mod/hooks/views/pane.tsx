import type { Color, RenderElement } from 'claude-code'

import type { Limit, Tab } from '../../types'
import { logo, meterSvg, tabIcon } from '../icons'
import { fileView } from './files'
import { clipEnd, plural } from '../text'
import { GLYPH } from '../tokens'
import { NARROW, PRESS_INSET, TIGHT, fit, hasFailed, paint, rule, space } from './chrome'
import { chillToggle, lyricRow, nowPlaying } from './chill'
import { consoleTab } from './console'
import { errorsTab } from './errors'
import { gitTab } from './git'
import { linearTab } from './linear'
import type { Actions, Kit, Model } from './model'
import { servicesTab } from './services'
import { until } from './usage'

export const TABS: readonly { id: Tab; hotkey: string; label: string }[] = [
  { id: 'git', hotkey: '1', label: 'Git' },
  { id: 'errors', hotkey: '2', label: 'Errors' },
  { id: 'services', hotkey: '3', label: 'Services' },
  { id: 'console', hotkey: '4', label: 'Console' },
  { id: 'linear', hotkey: '5', label: 'Linear' },
]

export const ICON_PX = 14

/** The mark's width beside the name. */
export const LOGO_PX = 18

export function pane(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box } = kit
  // A file being edited has the pane to itself: no tabs, no card, nothing else to press.
  // That the rest is gone is what says the pane is an editor now, and `done` brings it back.
  if (m.tab === 'git' && m.gitSection === 'files' && m.file !== null && m.file.isEditing) {
    return (
      <Box
        flexDirection="column"
        paddingX={1}
        {...(m.isTerminal && m.rows > 0 ? { minHeight: m.rows } : {})}
        {...(m.isTerminal && m.fill !== '' ? { backgroundColor: m.fill } : {})}
      >
        {fileView(kit, m, m.file, act)}
      </Box>
    )
  }

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      {...(m.isTerminal && m.rows > 0 ? { minHeight: m.rows } : {})}
      {...(m.isTerminal && m.fill !== '' ? { backgroundColor: m.fill } : {})}
    >
      {header(kit, m, act)}
      {space(kit)}
      {tabStrip(kit, m, act)}
      {rule(kit, m)}
      {m.isTerminal && space(kit)}
      {m.isChill && nowPlaying(kit, m, act)}
      {m.isChill && space(kit)}
      {m.tab === 'git' && gitTab(kit, m, act)}
      {m.tab === 'errors' && errorsTab(kit, m, act)}
      {m.tab === 'services' && servicesTab(kit, m, act)}
      {m.tab === 'console' && consoleTab(kit, m, act)}
      {m.tab === 'linear' && linearTab(kit, m, act)}
      {m.isTerminal && <Box flexGrow={1} minHeight={1} />}
      {m.isTerminal && legend(kit, m, act)}
      {!m.isTerminal && (
        // A cell grid's legend has `w: web`; here the same way out is a quiet word at the foot.
        <Box flexDirection="row" marginTop={1}>
          <Box flexGrow={1} />
          <kit.Button key="to-web" plain dimColor label="Open dashboard" onPress={() => act.openWeb()} />
        </Box>
      )}
    </Box>
  )
}

/** A band meter's size: eight cells on a grid; drawn, as long as that and a hair under a line of type. */
const BAND_BAR = { cells: 8, width: 64, height: 6 }

/** One limit in the band: its window, a meter of the share used in its status colour, and when it starts over. */
function limitPart(kit: Kit, m: Model, label: string, limit: Limit): RenderElement {
  const { Box, Text, Svg } = kit
  const tone = limit.usedPercent >= 90 ? m.colors.bad : limit.usedPercent >= 70 ? m.colors.busy : m.colors.ok
  const share = Math.max(0, Math.min(1, limit.usedPercent / 100))
  const full = Math.round(share * BAND_BAR.cells)
  const { width, height } = BAND_BAR
  const filled = share === 0 ? 0 : Math.max(height, Math.round(share * width))

  return (
    <Box flexDirection="row" alignItems="center" columnGap={1}>
      <Text dimColor>{label}</Text>
      {Svg === undefined ? (
        <Box flexDirection="row" flexShrink={0}>
          <Text color={tone}>{GLYPH.meter.repeat(full)}</Text>
          <Text color={m.colors.rule}>{GLYPH.meter.repeat(BAND_BAR.cells - full)}</Text>
        </Box>
      ) : (
        <Svg
          source={meterSvg(m.scheme, width, height, filled, tone)}
          alt={`${label}: ${limit.usedPercent}% used`}
          width={width}
          height={height}
        />
      )}
      <Text color={tone}>{limit.usedPercent}%</Text>
      {limit.resetsAt > m.now && <Text dimColor>{until(m.now, limit.resetsAt)} left</Text>}
    </Box>
  )
}

/** What a pane with nowhere to sit would have said: what is running, what changed, what broke. */
function summaryParts(kit: Kit, m: Model): RenderElement[] {
  const { Box, Text } = kit
  const parts: RenderElement[] = []
  const only = m.repos.length === 1 ? m.repos[0] : undefined

  if (m.counts.live > 0) {
    parts.push(
      <Box flexDirection="row">
        <Text color={m.colors.ok}>{GLYPH.on} </Text>
        <Text dimColor>{m.counts.live} running</Text>
      </Box>,
    )
  }
  for (const service of m.services.filter(hasFailed).slice(0, 2)) {
    parts.push(
      <Box flexDirection="row">
        <Text color={m.colors.bad}>{GLYPH.on} </Text>
        <Text>{service.name} </Text>
        <Text dimColor>exit {service.exitCode}</Text>
      </Box>,
    )
  }
  if (only !== undefined) {
    parts.push(
      <Box flexDirection="row">
        <Text>{clipEnd(only.branch, 24)}</Text>
        {only.ahead > 0 && <Text color={m.colors.busy}> {GLYPH.ahead}{only.ahead}</Text>}
        {only.behind > 0 && <Text color={m.colors.busy}> {GLYPH.behind}{only.behind}</Text>}
        {m.counts.changed > 0 && <Text dimColor> {m.counts.changed} changed</Text>}
      </Box>,
    )
  } else if (m.counts.changed > 0) {
    const dirty = m.repos.filter(repo => repo.files.length > 0).length
    parts.push(
      <Text dimColor>
        {m.counts.changed} changed in {plural(dirty, 'repo')}
      </Text>,
    )
  }
  if (m.counts.errors > 0) {
    parts.push(<Text color={m.colors.bad}>{plural(m.counts.errors, 'error')}</Text>)
  }

  return parts
}

/**
 * The band's one row above the prompt. For a pane that is on but has nowhere
 * to sit: its summary and a way to it. Seated or not: the Claude limits, the
 * five-hour window and the week. Nothing to say draws nothing.
 */
export function band(kit: Kit, m: Model, act: Actions, isSeated = false): RenderElement | undefined {
  const { Box, Text, Button } = kit
  const parts = isSeated ? [] : summaryParts(kit, m)

  if (m.limits?.fiveHour != null) parts.push(limitPart(kit, m, '5h', m.limits.fiveHour))
  if (m.limits?.weekly != null) parts.push(limitPart(kit, m, 'week', m.limits.weekly))
  // One row, never two: in chill mode with a song on, the lyric has it.
  const lyric = lyricRow(kit, m)
  if (lyric !== undefined || parts.length === 0) return lyric

  return (
    <Box flexDirection="row">
      <Text color={m.colors.accent}>{GLYPH.brand} </Text>
      {parts.map((part, at) => (
        <Box flexDirection="row">
          {at > 0 && <Text color={m.colors.rule}> {GLYPH.dot} </Text>}
          {part}
        </Box>
      ))}
      <Box flexGrow={1} />
      {!isSeated && <Button key="open" plain dimColor label="open pane" onPress={() => act.openPane()} />}
    </Box>
  )
}

/** The name and, where there is room, the folder; at the far end, what is running. */
export function header(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box, Text, Svg } = kit
  const folder = m.workspace.slice(m.workspace.lastIndexOf('/') + 1)
  // In a folder of several repositories, the one in view: what Git, Files and Actions are of.
  const picked = m.repo !== '' && m.repo !== m.workspace ? m.repo.slice(m.repo.lastIndexOf('/') + 1) : ''

  return (
    <Box flexDirection="row" alignItems="center">
      <Box flexShrink={0} flexDirection="row" alignItems="center" columnGap={Svg === undefined ? 0 : 1}>
        {Svg === undefined ? (
          <Text color={m.colors.accent}>{GLYPH.brand} </Text>
        ) : (
          <Svg source={logo(m.scheme)} alt="NoMoreIDE" width={LOGO_PX} />
        )}
        <Text bold>NoMoreIDE</Text>
      </Box>
      {folder !== '' && m.width >= NARROW && (
        <Box flexShrink={1} minWidth={0} marginLeft={2}>
          <Text dimColor wrap="truncate-end">
            {fit(m, picked === '' ? folder : `${folder} / ${picked}`, 32)}
          </Text>
        </Box>
      )}
      <Box flexGrow={1} />
      <Box flexShrink={0} marginRight={2}>
        {chillToggle(kit, m, act)}
      </Box>
      <Box flexShrink={0} flexDirection="row">
        {m.reach === 'up' && m.counts.live > 0 && <Text color={m.colors.ok}>{GLYPH.on} </Text>}
        {m.reach === 'up' && (
          <Text dimColor>{m.counts.live > 0 ? `${m.counts.live} running` : 'nothing running'}</Text>
        )}
        {m.reach === 'down' && <Text color={m.colors.inert}>{GLYPH.off} </Text>}
        {m.reach === 'down' && <Text dimColor>daemon offline</Text>}
      </Box>
    </Box>
  )
}

export function badgeOf(id: Tab, m: Model): { text: string; color?: Color } | undefined {
  // In a sidebar only the counts that are a status earn the room.
  const isQuietShown = m.width >= (m.isTerminal ? NARROW : TIGHT)
  if (id === 'git') {
    return m.counts.changed > 0 && isQuietShown ? { text: String(m.counts.changed) } : undefined
  }
  if (id === 'errors') {
    return m.counts.errors > 0
      ? { text: String(m.counts.errors), color: m.colors.bad }
      : undefined
  }
  if (id === 'services') {
    if (m.counts.failed > 0) return { text: String(m.counts.failed), color: m.colors.bad }

    return m.counts.live > 0 ? { text: String(m.counts.live), color: m.colors.ok } : undefined
  }

  if (id === 'linear') {
    return m.counts.tasks > 0 && isQuietShown ? { text: String(m.counts.tasks) } : undefined
  }

  return undefined
}

// The dashboard's TabStrip: the view in front reads foreground on background
// and is nothing to press; the others are quiet words that take a click. No
// tab shrinks or breaks in two; a strip too long for a sidebar wraps whole
// tabs onto a second line.
export function tabStrip(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box, Text, Button, Svg } = kit
  const isNarrow = m.width < (m.isTerminal ? NARROW : TIGHT)
  // The dashboard's navigation icon stands before each name where a surface
  // draws pictures; a press cannot hold one, so it sits beside it.
  const icon = (id: Tab, isFront: boolean): RenderElement | false =>
    Svg !== undefined && (
      <Svg
        source={tabIcon(id, isFront ? 'ink' : 'inkDim', m.scheme)}
        alt={`${id} view`}
        width={ICON_PX}
        height={ICON_PX}
      />
    )

  return (
    <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={isNarrow ? (m.isTerminal ? 1 : 1.5) : 2}>
      {TABS.map(one => {
        const badge = badgeOf(one.id, m)
        if (one.id === m.tab && !m.isTerminal) {
          // The surface's own primary button: its corners are the surface's.
          return (
            <Box flexShrink={0} flexDirection="row" alignItems="center" columnGap={PRESS_INSET}>
              {icon(one.id, true)}
              <Button
                key={`tab-${one.id}`}
                variant="primary"
                label={badge === undefined ? one.label : `${one.label} ${badge.text}`}
                onPress={() => act.setTab(one.id)}
              />
            </Box>
          )
        }
        if (one.id === m.tab) {
          return (
            <Box flexShrink={0} backgroundColor="text" paddingX={1}>
              <Text bold color="inverseText">
                {one.label}
                {badge === undefined ? '' : ` ${badge.text}`}
              </Text>
            </Box>
          )
        }

        return (
          <Box flexShrink={0} flexDirection="row" alignItems="center" paddingX={isNarrow ? 0 : 1}>
            {icon(one.id, false)}
            <Button
              key={`tab-${one.id}`}
              plain
              dimColor
              label={one.label}
              onPress={() => act.setTab(one.id)}
            />
            {badge !== undefined && <Text {...paint(badge.color)}> {badge.text}</Text>}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * A cell grid's last line, the keys: every view by number, and the way out.
 * Elsewhere the views are a click away and the line is left out.
 */
export function legend(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  const hint = m.isFocused ? 'esc prompt' : 'click or ctrl+x tab'

  return (
    <Box flexDirection="column" flexShrink={0}>
      {rule(kit, m)}
      <Box flexDirection="row" columnGap={2}>
        {TABS.map(one => (
          <Button
            key={`key-${one.id}`}
            plain
            dimColor
            hotkey={one.hotkey}
            label={one.label.toLowerCase()}
            onPress={() => act.setTab(one.id)}
          />
        ))}
        <Button key="to-web" plain dimColor hotkey="w" label="web" onPress={() => act.openWeb()} />
        <Box flexGrow={1} />
        {m.width >= 60 + hint.length && <Text dimColor>{hint}</Text>}
      </Box>
    </Box>
  )
}
