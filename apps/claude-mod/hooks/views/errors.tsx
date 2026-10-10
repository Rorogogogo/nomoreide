import type { Color, RenderElement } from 'claude-code'

import type { Incident } from '../../types'
import { age, clipStart } from '../text'
import { GLYPH } from '../tokens'
import type { Palette } from '../tokens'
import {
  MAX_ROWS,
  chip,
  fit,
  group,
  heading,
  more,
  offline,
  quiet,
  row,
  rule,
  space,
} from './chrome'
import type { Actions, Kit, Model } from './model'

export const levelTone = (incident: Incident, colors: Palette): Color =>
  incident.level.startsWith('warn') ? colors.busy : colors.bad

export function whereOf(incident: Incident): string {
  if (incident.file === '') return ''

  return incident.line === null ? incident.file : `${incident.file}:${incident.line}`
}

export function errorsTab(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  if (m.reach !== 'up') return offline(kit, m)
  const open = m.incidents.find(one => one.id === m.incident)
  if (open !== undefined) return incidentView(kit, m, open, act)
  if (m.incidents.length === 0) {
    return quiet(
      kit,
      m,
      '✓',
      'No errors captured',
      'What a managed service logs as an error lands here.',
    )
  }

  return (
    <Box flexDirection="column">
      {heading(kit, 'ERRORS', m.incidents.length)}
      {group(kit, m, m.incidents.slice(0, MAX_ROWS).map(incident => {
        const seen = age(m.now, incident.lastSeen)
        const meta = [
          incident.service,
          whereOf(incident),
          incident.count > 1 ? `${GLYPH.times}${incident.count}` : '',
        ]
          .filter(part => part !== '')
          .join(` ${GLYPH.dot} `)

        return row(
          kit,
          m,
          `row:${incident.id}`,
          { glyph: GLYPH.on, color: levelTone(incident, m.colors) },
          <Button
            key={`incident:${incident.id}`}
            plain
            label={fit(m, incident.title, seen.length + 4)}
            onPress={() => act.openIncident(incident.id)}
          />,
          <Text dimColor>{seen}</Text>,
          meta,
        )
      }))}
      {more(kit, m.incidents.length - MAX_ROWS, 'errors')}
    </Box>
  )
}

export function incidentView(kit: Kit, m: Model, incident: Incident, act: Actions): RenderElement {
  const { Box, Text, Button, Code } = kit
  const where = whereOf(incident)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Button key="back" plain dimColor hotkey="b" label="back" onPress={() => act.closeIncident()} />
        <Box flexGrow={1} />
        <Button
          key="fix"
          {...chip(m, false)}
          hotkey="f"
          label="fix with Claude"
          onPress={() => act.fixIncident(incident.id)}
        />
      </Box>
      {space(kit)}
      <Box flexDirection="row" alignItems="flex-start">
        <Box flexShrink={0} marginRight={1}>
          <Text color={levelTone(incident, m.colors)}>{GLYPH.on}</Text>
        </Box>
        <Box flexDirection="column" flexShrink={1} minWidth={0}>
          <Text bold>{incident.title}</Text>
          <Text dimColor>
            {incident.service}
            {incident.count > 1 ? ` ${GLYPH.dot} ${GLYPH.times}${incident.count}` : ''}
            {` ${GLYPH.dot} first ${age(m.now, incident.firstSeen)} ago`}
            {` ${GLYPH.dot} last ${age(m.now, incident.lastSeen)} ago`}
          </Text>
          {where !== '' && (
            <Text dimColor wrap="truncate-end">
              {m.isTerminal ? clipStart(where, m.width - 2) : where}
            </Text>
          )}
        </Box>
      </Box>
      {rule(kit, m)}
      {incident.excerpt === '' ? (
        <Text dimColor>No log lines were kept for this one.</Text>
      ) : (
        <Code source={incident.excerpt} />
      )}
    </Box>
  )
}
