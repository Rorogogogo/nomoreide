import type { RenderElement } from 'claude-code'

import type { Tool, ToolKind } from '../../types'
import { clipEnd } from '../text'
import { GLYPH } from '../tokens'
import { MAX_ROWS, NARROW, chip, fit, group, heading, more, quiet, rowHover, space } from './chrome'
import type { Actions, Kit, Model } from './model'

export const TOOL_KINDS: readonly { id: ToolKind; label: string }[] = [
  { id: 'skills', label: 'SKILLS' },
  { id: 'mcp', label: 'MCP SERVERS' },
  { id: 'plugins', label: 'PLUGINS' },
  { id: 'hooks', label: 'HOOKS' },
]

/**
 * What Claude Code has installed, a kind at a time: four counts, one list
 * unfolded. A name takes a press and lands in the prompt: a skill as its
 * slash command, a server or a plugin by name.
 */
export function toolsView(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  const tools = m.tools
  if (tools === null) return quiet(kit, m, GLYPH.off, 'Reading what is installed', 'One moment.')
  const line = (kind: ToolKind, one: Tool, at: number): RenderElement => (
    <Box key={`row:tool:${kind}:${at}`} flexDirection="row" {...(kind === 'hooks' ? {} : rowHover(m))}>
      <Box flexShrink={1} minWidth={0}>
        {kind === 'hooks' ? (
          // A hook is nothing to ask for by name: it runs by itself.
          <Text wrap="truncate-end">{fit(m, one.name, 2)}</Text>
        ) : (
          <Button
            key={`tool:${kind}:${one.name}`}
            plain
            label={fit(m, kind === 'skills' ? `/${one.name}` : one.name, 26)}
            onPress={() => act.toolToPrompt(kind, one.name)}
          />
        )}
      </Box>
      <Box flexGrow={1} />
      {one.detail !== '' && m.width >= NARROW && (
        <Box flexShrink={0} marginLeft={2}>
          <Text dimColor>{clipEnd(one.detail, 24)}</Text>
        </Box>
      )}
    </Box>
  )

  return (
    <Box flexDirection="column">
      {TOOL_KINDS.map((kind, at) => {
        const some = tools[kind.id]
        const isOpen = m.toolKind === kind.id

        return (
          <Box key={`tools:${kind.id}`} flexDirection="column">
            {at > 0 && space(kit)}
            {heading(
              kit,
              kind.label,
              some.length,
              some.length > 0 ? (
                <Button
                  key={`tools-${kind.id}`}
                  {...chip(m)}
                  label={isOpen ? 'hide' : 'show'}
                  onPress={() => act.toggleTools(kind.id)}
                />
              ) : undefined,
            )}
            {isOpen && group(kit, m, some.slice(0, MAX_ROWS).map((one, index) => line(kind.id, one, index)), 0)}
            {isOpen && more(kit, some.length - MAX_ROWS, 'more')}
          </Box>
        )
      })}
    </Box>
  )
}
