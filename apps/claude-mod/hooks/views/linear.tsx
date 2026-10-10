import type { RenderElement } from 'claude-code'

import type { Task } from '../../types'
import { age } from '../text'
import { GLYPH } from '../tokens'
import { MAX_ROWS, chip, fit, group, heading, offline, quiet, row, space } from './chrome'
import type { Actions, Kit, Model } from './model'

export const TASK_GROUPS: readonly { label: string; types: readonly string[] }[] = [
  { label: 'IN PROGRESS', types: ['started'] },
  { label: 'TODO', types: ['unstarted'] },
  { label: 'BACKLOG', types: ['backlog', 'triage'] },
]

/** The open Linear work that is the person's own or nobody's; a press drafts one into the prompt. */
export function linearTab(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  if (m.reach !== 'up') return offline(kit, m)
  if (m.tasks === null) return quiet(kit, m, GLYPH.off, 'Reading Linear', 'One moment.')
  if (!m.tasks.isConnected) {
    return quiet(kit, m, GLYPH.off, 'Linear is not connected', 'Connect it in the NoMoreIDE dashboard: /nomoreide web.')
  }
  if (m.tasks.tasks.length === 0) {
    return quiet(kit, m, '✓', 'No open tasks', 'Nothing in Linear is yours or unassigned.')
  }
  const tasks = m.tasks.tasks
  const one = (task: Task): RenderElement => {
    const meta = [
      task.state,
      task.project,
      task.isMine ? '' : 'unassigned',
      task.updatedAt === '' ? '' : `${age(m.now, task.updatedAt)} ago`,
    ]
      .filter(part => part !== '')
      .join(` ${GLYPH.dot} `)

    return row(
      kit,
      m,
      `row:task:${task.id}`,
      task.stateType === 'started'
        ? { glyph: GLYPH.on, color: m.colors.busy }
        : { glyph: GLYPH.off, color: m.colors.inert },
      <Button
        key={`task-open:${task.identifier}`}
        plain
        label={fit(m, `${task.identifier} ${task.title}`, 14)}
        onPress={() => act.openUrl(task.url)}
      />,
      <Button key={`task:${task.identifier}`} {...chip(m)} label="to prompt" onPress={() => act.taskToPrompt(task.id)} />,
      meta,
    )
  }
  const groups = TASK_GROUPS.map(group_ => ({
    label: group_.label,
    tasks: tasks.filter(task => group_.types.includes(task.stateType)),
  })).filter(group_ => group_.tasks.length > 0)

  return (
    <Box flexDirection="column">
      {groups.map((group_, at) => (
        <Box key={`tasks:${group_.label}`} flexDirection="column">
          {at > 0 && space(kit)}
          {heading(kit, group_.label, group_.tasks.length)}
          {group(kit, m, group_.tasks.slice(0, MAX_ROWS).map(one))}
        </Box>
      ))}
      {m.tasks.hasMore && <Text dimColor>… older issues are in the dashboard</Text>}
    </Box>
  )
}
