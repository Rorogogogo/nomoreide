import type { RenderElement } from 'claude-code'

import type { Section } from '../../types'
import { changeDiffView, changeSetView, changesList } from './changes'
import { offline, space, strip } from './chrome'
import type { Actions, Kit, Model } from './model'
import { toolsView } from './tools'
import { usageView } from './usage'

export const SECTIONS: readonly { id: Section; hotkey: string; label: string }[] = [
  { id: 'changes', hotkey: 'c', label: 'Changes' },
  { id: 'usage', hotkey: 'g', label: 'Usage' },
  { id: 'tools', hotkey: 't', label: 'Tools' },
]

export function consoleTab(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box } = kit
  if (m.reach !== 'up') return offline(kit, m)
  if (m.section === 'changes' && m.changeDiff !== null) return changeDiffView(kit, m, m.changeDiff, act)
  const open = m.changeSet === null ? undefined : m.changeSets.find(one => one.id === m.changeSet?.id)
  if (m.section === 'changes' && open !== undefined && m.changeSet !== null) {
    return changeSetView(kit, m, open, m.changeSet, act)
  }

  return (
    <Box flexDirection="column">
      {strip(kit, m, SECTIONS, m.section, act.setSection)}
      {space(kit)}
      {m.section === 'changes' && changesList(kit, m, act)}
      {m.section === 'usage' && usageView(kit, m)}
      {m.section === 'tools' && toolsView(kit, m, act)}
    </Box>
  )
}
