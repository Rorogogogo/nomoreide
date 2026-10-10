import type { RenderElement } from 'claude-code'

import type { ChangeDiff, ChangeSet, OpenChangeSet } from '../../types'
import { age, clipStart, plural, splitPath } from '../text'
import { GLYPH } from '../tokens'
import {
  MAX_ROWS,
  NARROW,
  chip,
  fit,
  group,
  heading,
  letter,
  more,
  quiet,
  repoNameOf,
  row,
  rowHover,
  rule,
  space,
  toneOf,
  twice,
} from './chrome'
import type { Actions, Kit, Model } from './model'

/** When a recorded session started, as a title for one that was given no name. */
export const startOf = (set: ChangeSet): string => set.startedAt.slice(0, 16).replace('T', ' ')

export function setMeta(set: ChangeSet): string {
  return [
    set.provider,
    plural(set.toolCount, 'tool call'),
    repoNameOf(set.repoPath),
    set.sha === '' ? 'no snapshot' : set.sha.slice(0, 7),
  ]
    .filter(part => part !== '')
    .join(` ${GLYPH.dot} `)
}

/** What the AI touched: each recorded session, against the snapshot taken before its work. */
export function changesList(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  if (m.changeSets.length === 0) {
    return quiet(
      kit,
      m,
      GLYPH.off,
      'No agent sessions recorded here',
      'Work an agent does through NoMoreIDE in this folder is listed with what it changed.',
    )
  }

  return (
    <Box flexDirection="column">
      {heading(kit, 'AGENT SESSIONS', m.changeSets.length)}
      {group(kit, m, m.changeSets.slice(0, MAX_ROWS).map(set => {
        const seen = age(m.now, set.lastToolAt || set.startedAt)

        return row(
          kit,
          m,
          `row:set:${set.id}`,
          set.sha === ''
            ? { glyph: GLYPH.off, color: m.colors.inert }
            : { glyph: GLYPH.on, color: m.colors.inert },
          <Button
            key={`set:${set.id}`}
            plain
            label={fit(m, set.label || startOf(set), seen.length + 4)}
            onPress={() => act.openChangeSet(set.id)}
          />,
          <Text dimColor>{seen}</Text>,
          setMeta(set),
        )
      }))}
      {more(kit, m.changeSets.length - MAX_ROWS, 'sessions')}
    </Box>
  )
}

export function changeSetView(
  kit: Kit,
  m: Model,
  set: ChangeSet,
  open: OpenChangeSet,
  act: Actions,
): RenderElement {
  const { Box, Text, Button } = kit

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={m.width < NARROW ? 1 : 3}>
        <Button key="back" plain dimColor hotkey="b" label="back" onPress={() => act.closeChangeSet()} />
        <Box flexGrow={1} />
        {set.sha !== '' &&
          open.files.length > 0 &&
          twice(kit, m, act, `restore-set:${set.id}`, 'restore', () => act.restoreChangeSet(set.id))}
      </Box>
      {space(kit)}
      <Text bold wrap="truncate-end">
        {fit(m, set.label || startOf(set), 2)}
      </Text>
      <Text dimColor wrap="truncate-end">
        {setMeta(set)}
      </Text>
      {space(kit)}
      {set.sha === '' && <Text dimColor>This session was recorded before a snapshot could be taken.</Text>}
      {set.sha !== '' && open.files.length === 0 && (
        <Text dimColor>Nothing differs from the snapshot taken before this session.</Text>
      )}
      {open.files.length > 0 && heading(kit, 'CHANGED SINCE', open.files.length)}
      {open.files.length > 0 &&
        group(kit, m, open.files.slice(0, MAX_ROWS).map(file => {
          const { name, dir } = splitPath(file.path)
          const shown = fit(m, name, 6)

          return (
            <Box key={`row:setfile:${file.path}`} flexDirection="row" {...rowHover(m)}>
              {letter(kit, m, file.status)}
              <Box flexShrink={0}>
                <Button
                  key={`setfile:${file.path}`}
                  plain
                  label={shown}
                  onPress={() => act.openChangeDiff(set.id, file.path)}
                />
              </Box>
              {dir !== '' && (
                <Box flexShrink={1} minWidth={0} marginLeft={2}>
                  <Text dimColor wrap="truncate-end">
                    {m.isTerminal ? clipStart(dir, Math.max(0, m.width - shown.length - 6)) : dir}
                  </Text>
                </Box>
              )}
            </Box>
          )
        }), 0)}
      {more(kit, open.files.length - MAX_ROWS, 'files')}
    </Box>
  )
}

export function changeDiffView(kit: Kit, m: Model, diff: ChangeDiff, act: Actions): RenderElement {
  const { Box, Text, Button, Code } = kit
  const { name, dir } = splitPath(diff.path)
  const set = m.changeSets.find(one => one.id === diff.id)
  const status = m.changeSet?.files.find(one => one.path === diff.path)?.status ?? 'M'

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={m.width < NARROW ? 1 : 3}>
        <Button key="back" plain dimColor hotkey="b" label="back" onPress={() => act.closeChangeDiff()} />
        <Box flexGrow={1} />
        {set !== undefined && (
          <Button
            key="mention"
            {...chip(m, false)}
            hotkey="p"
            label="to prompt"
            onPress={() => act.mention(set.repoPath, diff.path)}
          />
        )}
      </Box>
      {space(kit)}
      <Box flexDirection="row" alignItems="flex-start">
        <Box flexShrink={0} marginRight={1}>
          <Text bold color={toneOf(status, m.colors)}>
            {status}
          </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
          <Text bold wrap="truncate-end">
            {fit(m, name, 4)}
          </Text>
          <Text dimColor wrap="truncate-end">
            {['since the snapshot', m.isTerminal ? clipStart(dir, m.width - 24) : dir]
              .filter(part => part !== '')
              .join(` ${GLYPH.dot} `)}
          </Text>
        </Box>
      </Box>
      {rule(kit, m)}
      {diff.hunks === '' ? (
        <Text dimColor>Nothing to show as text: a binary file, or one that no longer differs.</Text>
      ) : (
        <Code source={diff.hunks} format="diff" path={diff.path} />
      )}
      {more(kit, diff.hiddenLines, 'lines')}
    </Box>
  )
}
