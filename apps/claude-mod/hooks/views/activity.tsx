import type { Color, RenderElement } from 'claude-code'

import { GLYPH } from '../tokens'
import { group, heading, quiet, space } from './chrome'
import type { Kit, Model } from './model'
import { metered, stat } from './usage'

const gigabytes = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`

const megabytes = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`)

/** A share's colour once it presses: amber from three quarters, red from nine tenths. */
const pressure = (percent: number, m: Model): Color | undefined =>
  percent >= 90 ? m.colors.bad : percent >= 75 ? m.colors.busy : undefined

/** What the machine is doing now: its processor, memory and disk, then who is using them. */
export function activityView(kit: Kit, m: Model): RenderElement {
  const { Box } = kit
  const activity = m.activity
  if (activity === null) return quiet(kit, m, GLYPH.off, 'Measuring', 'One moment.')
  const { memory, disk } = activity
  const cpu = activity.cpuPercent ?? 0
  const load = activity.load === null ? '' : `load ${activity.load.toFixed(2)}`

  return (
    <Box flexDirection="column">
      {heading(kit, 'THIS MACHINE')}
      {group(kit, m, [
        metered(
          kit,
          m,
          'stat:cpu',
          'Processor',
          `${Math.round(cpu)}%`,
          cpu / 100,
          [`${activity.cores} cores`, load].filter(part => part !== '').join(` ${GLYPH.dot} `),
          pressure(cpu, m),
        ),
        metered(
          kit,
          m,
          'stat:memory',
          'Memory',
          `${Math.round(memory.usedPercent)}%`,
          memory.usedPercent / 100,
          `${gigabytes(memory.usedBytes)} of ${gigabytes(memory.totalBytes)}`,
          pressure(memory.usedPercent, m),
        ),
        disk !== null &&
          metered(
            kit,
            m,
            'stat:disk',
            'Disk',
            `${Math.round(disk.usedPercent)}%`,
            disk.usedPercent / 100,
            `${gigabytes(disk.availableBytes)} free`,
            pressure(disk.usedPercent, m),
          ),
      ])}
      {activity.services.length > 0 && space(kit)}
      {activity.services.length > 0 && heading(kit, 'MANAGED SERVICES', activity.services.length)}
      {activity.services.length > 0 &&
        group(kit, m, activity.services.map(one =>
          stat(kit, m, `stat:service:${one.name}`, one.name, `${one.cpuPercent.toFixed(1)}%`, megabytes(one.rssMb)),
        ))}
      {activity.processes.length > 0 && space(kit)}
      {activity.processes.length > 0 && heading(kit, 'BUSIEST PROCESSES', activity.processes.length)}
      {activity.processes.length > 0 &&
        group(kit, m, activity.processes.map(one =>
          stat(
            kit,
            m,
            `stat:process:${one.pid}`,
            one.name,
            `${one.cpuPercent.toFixed(1)}%`,
            [megabytes(one.rssMb), `pid ${one.pid}`, one.service].filter(part => part !== '').join(` ${GLYPH.dot} `),
          ),
        ))}
    </Box>
  )
}
