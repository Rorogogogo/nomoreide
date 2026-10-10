import type { Color, RenderElement } from 'claude-code'

import type { Logs, Service, ServiceSection, Trend } from '../../types'
import { addServicePrompt, debugServicePrompt } from '../prompts'
import { clipEnd, tilde } from '../text'
import { GLYPH } from '../tokens'
import type { Palette } from '../tokens'
import {
  MAX_ROWS,
  NARROW,
  ask,
  chip,
  fit,
  group,
  hasFailed,
  heading,
  isLive,
  logBody,
  offline,
  quiet,
  row,
  rule,
  space,
  strip,
} from './chrome'
import { activityView } from './activity'
import { trendChart } from './usage'
import { databaseList, rowsView, tablesView } from './database'
import type { Actions, Kit, Model, ServiceVerb } from './model'

export function healthOf(
  service: Service,
  colors: Palette,
): { glyph: string; color: Color; word: string } {
  if (service.state === 'running') return { glyph: GLYPH.on, color: colors.ok, word: '' }
  if (service.state === 'starting' || service.state === 'stopping') {
    return { glyph: GLYPH.on, color: colors.busy, word: service.state }
  }
  if (hasFailed(service)) {
    return { glyph: GLYPH.on, color: colors.bad, word: `exit ${service.exitCode}` }
  }

  return { glyph: GLYPH.off, color: colors.inert, word: '' }
}

/** A service: what it is and what can be done to it, then where it listens and how it runs. */
export function serviceRow(kit: Kit, m: Model, act: Actions, service: Service): RenderElement {
  const { Box, Text, Button } = kit
  const health = healthOf(service, m.colors)
  const live = isLive(service)
  const verbs: readonly ServiceVerb[] = live ? ['restart', 'stop'] : ['start']
  const reserved = verbs.join('  ').length + health.word.length + 6
  const meta = [
    service.port === null ? '' : `:${service.port}`,
    service.command !== '' ? service.command : tilde(service.cwd, m.home),
  ]
    .filter(part => part !== '')
    .join(` ${GLYPH.dot} `)

  return row(
    kit,
    m,
    `row:${service.name}`,
    { glyph: health.glyph, color: health.color },
    <Button
      key={`logs:${service.name}`}
      plain
      dimColor={!live && !hasFailed(service)}
      label={fit(m, service.name, reserved)}
      onPress={() => act.openLogs(service.name)}
    />,
    <Box flexDirection="row" columnGap={m.width < NARROW ? 1 : 2}>
      {health.word !== '' && <Text color={health.color}>{health.word}</Text>}
      {verbs.map(verb => (
        <Button
          key={`${verb}:${service.name}`}
          {...chip(m)}
          label={verb}
          onPress={() => act.service(service.name, verb)}
        />
      ))}
    </Box>,
    meta,
  )
}

const SERVICE_SECTIONS: readonly { id: ServiceSection; hotkey: string; label: string }[] = [
  { id: 'services', hotkey: 'v', label: 'Services' },
  { id: 'activity', hotkey: 'y', label: 'Activity' },
  { id: 'database', hotkey: 'd', label: 'Database' },
]

export function servicesTab(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box } = kit
  if (m.reach !== 'up') return offline(kit, m)
  const open = m.logs === null ? undefined : m.services.find(one => one.name === m.logs?.name)
  if (m.serviceSection === 'services' && open !== undefined && m.logs !== null) {
    return logsView(kit, m, open, m.logs, act)
  }
  if (m.serviceSection === 'database' && m.dbRows !== null) return rowsView(kit, m, m.dbRows, act)
  if (m.serviceSection === 'database' && m.dbTables !== null) return tablesView(kit, m, m.dbTables, act)

  return (
    <Box flexDirection="column">
      {strip(kit, m, SERVICE_SECTIONS, m.serviceSection, act.setServiceSection)}
      {space(kit)}
      {m.serviceSection === 'services' && serviceList(kit, m, act)}
      {m.serviceSection === 'activity' && activityView(kit, m)}
      {m.serviceSection === 'database' && databaseList(kit, m, act)}
    </Box>
  )
}

function serviceList(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box, Button } = kit
  if (m.services.length === 0) {
    return quiet(
      kit,
      m,
      GLYPH.off,
      'No services registered',
      'Register one in NoMoreIDE to run and watch it from here.',
    )
  }

  // Running first, then what belongs to this folder. Everything else the
  // daemon knows of is counted and folded away: a session rarely cares about
  // another project's database.
  const isHere = (service: Service): boolean =>
    m.workspace !== '' &&
    service.cwd !== '' &&
    (service.cwd === m.workspace ||
      service.cwd.startsWith(`${m.workspace}/`) ||
      m.workspace.startsWith(`${service.cwd}/`))
  const active = m.services.filter(one => isLive(one) || hasFailed(one))
  const idle = m.services.filter(one => !isLive(one) && !hasFailed(one))
  const here = idle.filter(isHere)
  const elsewhere = idle.filter(one => !isHere(one))
  const rows = (some: readonly Service[]): RenderElement | false =>
    some.length > 0 &&
    group(kit, m, some.slice(0, MAX_ROWS).map(service => serviceRow(kit, m, act, service)))

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box flexGrow={1} />
        {ask(kit, m, act, 'ask-service', 'add a service', () => addServicePrompt(m.workspace))}
      </Box>
      {active.length > 0 && heading(kit, 'ACTIVE', active.length)}
      {rows(active)}
      {active.length > 0 && here.length > 0 && space(kit)}
      {here.length > 0 && heading(kit, 'THIS WORKSPACE', here.length)}
      {rows(here)}
      {active.length + here.length > 0 && elsewhere.length > 0 && space(kit)}
      {elsewhere.length > 0 &&
        heading(
          kit,
          'ELSEWHERE',
          elsewhere.length,
          <Button
            key="elsewhere"
            {...chip(m)}
            hotkey="e"
            label={m.showsElsewhere ? 'hide' : 'show'}
            onPress={() => act.toggleElsewhere()}
          />,
        )}
      {m.showsElsewhere && rows(elsewhere)}
    </Box>
  )
}

/** A round figure a little over `peak`, so an axis's top mark reads cleanly. */
function ceilingOf(peak: number): number {
  const step = 10 ** Math.floor(Math.log10(Math.max(peak, 1)))
  const unit = step >= 10 ? step / 2 : 1

  return Math.ceil((peak * 1.05) / unit) * unit
}

/** A running service's processor share and memory over time: the first against a whole core or its own peak, the second against its peak. */
function serviceTrend(kit: Kit, m: Model, trend: Trend): RenderElement {
  const cpuNow = trend.cpu[trend.cpu.length - 1] ?? 0
  const memoryNow = trend.memory[trend.memory.length - 1] ?? 0
  const megabytes = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`)

  return trendChart(
    kit,
    m,
    'trend:service',
    trend,
    { label: 'CPU', top: Math.max(100, ...trend.cpu), now: `${cpuNow.toFixed(1)}%`, unit: value => `${Math.round(value)}%` },
    { label: 'Memory', top: ceilingOf(Math.max(1, ...trend.memory)), now: megabytes(memoryNow), unit: megabytes },
  )
}

export function logsView(
  kit: Kit,
  m: Model,
  service: Service,
  logs: Logs,
  act: Actions,
): RenderElement {
  const { Box, Text, Button } = kit
  const health = healthOf(service, m.colors)
  const live = isLive(service)
  const standing =
    (health.word === '' ? service.state : health.word) +
    (service.pid === null ? '' : ` ${GLYPH.dot} pid ${service.pid}`)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={m.width < NARROW ? 1 : 3}>
        <Button key="back" plain dimColor hotkey="b" label="back" onPress={() => act.closeLogs()} />
        <Box flexGrow={1} />
        {live ? (
          <Button key="restart" {...chip(m, false)} hotkey="r" label="restart" onPress={() => act.service(service.name, 'restart')} />
        ) : (
          <Button key="start" {...chip(m, false)} hotkey="s" label="start" onPress={() => act.service(service.name, 'start')} />
        )}
        {live && (
          <Button key="stop" {...chip(m, false)} hotkey="x" label="stop" onPress={() => act.service(service.name, 'stop')} />
        )}
        {ask(kit, m, act, 'ask-debug', 'debug', () => debugServicePrompt(service, logs.lines))}
      </Box>
      {space(kit)}
      <Box flexDirection="row" alignItems="flex-start">
        <Box flexShrink={0} marginRight={1}>
          <Text color={health.color}>{health.glyph}</Text>
        </Box>
        <Box flexDirection="column" flexShrink={1} minWidth={0}>
          <Text bold wrap="truncate-end">
            {fit(m, service.name, 4)}
          </Text>
          <Text dimColor wrap="truncate-end">
            {service.port === null ? '' : `:${service.port} ${GLYPH.dot} `}
            {standing}
          </Text>
          {service.command !== '' && (
            <Text dimColor wrap="truncate-end">
              {m.isTerminal ? clipEnd(service.command, m.width - 2) : service.command}
            </Text>
          )}
        </Box>
      </Box>
      {logs.trend !== null && live && space(kit)}
      {logs.trend !== null && live && serviceTrend(kit, m, logs.trend)}
      {rule(kit, m)}
      {logs.lines.length === 0 && <Text dimColor>No output yet.</Text>}
      {logs.lines.length > 0 && logBody(kit, m, logs.lines)}
    </Box>
  )
}
