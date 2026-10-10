import type { RenderElement } from 'claude-code'

import type { Entry, OpenFile } from '../../types'
import { EDIT_LINES, VIEW_LINES, linesOf, shownLine } from '../files'
import { clipEnd, clipStart, splitPath } from '../text'
import { GLYPH } from '../tokens'
import { MAX_ROWS, NARROW, chip, fit, group, heading, more, quiet, rowHover, rule, space } from './chrome'
import type { Actions, Kit, Model } from './model'

/** A path as the pane names it: from the session's folder down. */
const within = (path: string, m: Model): string =>
  path === m.workspace ? '' : path.startsWith(`${m.workspace}/`) ? path.slice(m.workspace.length + 1) : path

/** The session's folder, a level at a time: folders open, files are read. */
export function browser(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box, Text, Button } = kit
  const listing = m.listing
  if (listing === null) return quiet(kit, m, GLYPH.off, 'Reading the folder', 'One moment.')
  const here = within(listing.path, m)
  const one = (entry: Entry): RenderElement => {
    const isDir = entry.kind === 'dir'
    const path = `${listing.path}/${entry.name}`

    return (
      <Box key={`row:entry:${entry.name}`} flexDirection="row" {...rowHover(m)}>
        <Box flexShrink={0} {...(m.isTerminal ? { marginRight: 1 } : { width: 2 })}>
          <Text color={m.colors.inert}>{isDir ? '▸' : ' '}</Text>
        </Box>
        <Box flexShrink={1} minWidth={0}>
          <Button
            key={`entry:${entry.name}`}
            plain
            dimColor={entry.kind === 'other'}
            label={fit(m, isDir ? `${entry.name}/` : entry.name, 4)}
            onPress={() => (isDir ? act.openDir(path) : act.openFile(path))}
          />
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" alignItems="center">
        {here !== '' && (
          <Box flexShrink={0} marginRight={2}>
            <Button
              key="up"
              plain
              dimColor
              hotkey="b"
              label="up"
              onPress={() => act.openDir(listing.path.slice(0, listing.path.lastIndexOf('/')))}
            />
          </Box>
        )}
        <Box flexShrink={1} minWidth={0}>
          <Text bold wrap="truncate-end">
            {m.isTerminal ? clipStart(here === '' ? splitPath(m.workspace).name : here, m.width - 8) : here || splitPath(m.workspace).name}
          </Text>
        </Box>
      </Box>
      {space(kit)}
      {listing.entries.length === 0 ? (
        <Text dimColor>An empty folder.</Text>
      ) : (
        heading(kit, 'FILES', listing.entries.length)
      )}
      {listing.entries.length > 0 && group(kit, m, listing.entries.slice(0, MAX_ROWS).map(one), 0)}
      {more(kit, listing.entries.length - MAX_ROWS, 'entries')}
    </Box>
  )
}

/** Leading spaces as ones a label keeps: a surface that sets type folds plain ones away. */
const indented = (line: string): string => line.replace(/^[ \t]+/, lead => lead.replace(/\t/g, '  ').replace(/ /g, ' '))

/**
 * A file: read as highlighted code, or, being edited, as lines that take a
 * press. The line pressed opens in the pane's one-line text field, above the
 * list where it stays in sight.
 */
export function fileView(kit: Kit, m: Model, file: OpenFile, act: Actions): RenderElement {
  const { Box, Text, Button, Code, Input } = kit
  const { name, dir } = splitPath(within(file.path, m))
  const lines = file.note === '' ? linesOf(file.text) : []
  const size = file.isEditing ? EDIT_LINES : VIEW_LINES
  const shown = lines.slice(file.top, file.top + size)
  const last = Math.min(lines.length, file.top + size)
  const picked = file.line === null ? undefined : lines[file.line - 1]
  const gap = m.width < NARROW ? 1 : 2
  const digits = String(last).length

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={gap}>
        <Button key="back" plain dimColor hotkey="b" label="back" onPress={() => act.closeFile()} />
        <Box flexGrow={1} />
        {file.note === '' && Input !== undefined && (
          <Button
            key="edit"
            {...chip(m, false)}
            hotkey="e"
            label={file.isEditing ? 'done' : 'edit'}
            onPress={() => act.toggleEdit()}
          />
        )}
        <Button
          key="mention"
          {...chip(m, false)}
          hotkey="p"
          label="to prompt"
          onPress={() => act.mention(m.workspace, within(file.path, m))}
        />
      </Box>
      {space(kit)}
      <Text bold wrap="truncate-end">
        {fit(m, name, 2)}
      </Text>
      <Text dimColor wrap="truncate-end">
        {[
          m.isTerminal ? clipStart(dir, m.width - 28) : dir,
          lines.length === 0 ? '' : `lines ${file.top + 1}${GLYPH.dash}${last} of ${lines.length}`,
        ]
          .filter(part => part !== '')
          .join(` ${GLYPH.dot} `)}
      </Text>
      {lines.length > size && (
        <Box flexDirection="row" columnGap={gap} marginTop={m.isTerminal ? 0 : 1}>
          {file.top > 0 && <Button key="page-back" {...chip(m)} hotkey="k" label="earlier" onPress={() => act.pageFile(-1)} />}
          {last < lines.length && <Button key="page-on" {...chip(m)} hotkey="j" label="later" onPress={() => act.pageFile(1)} />}
        </Box>
      )}
      {file.isEditing && file.line !== null && picked !== undefined && Input !== undefined && (
        <Box flexDirection="column" marginTop={1}>
          <Input
            key={`line-text:${file.line}`}
            label={`line ${file.line}`}
            value={shownLine(picked)}
            placeholder="an empty line"
            submitLabel="save"
            autoFocus
            onSubmit={value => act.editLine({ kind: 'replace', line: file.line ?? 0, value })}
          />
          <Box flexDirection="row" columnGap={gap}>
            <Button key="line-insert" {...chip(m)} label="new line below" onPress={() => act.editLine({ kind: 'insert', line: file.line ?? 0 })} />
            <Button key="line-delete" {...chip(m)} label="delete line" onPress={() => act.editLine({ kind: 'delete', line: file.line ?? 0 })} />
            <Box flexGrow={1} />
            <Button key="line-cancel" {...chip(m)} label="cancel" onPress={() => act.pickLine(null)} />
          </Box>
        </Box>
      )}
      {rule(kit, m)}
      {file.note !== '' && <Text dimColor>{file.note}</Text>}
      {file.note === '' && lines.length === 0 && !file.isEditing && <Text dimColor>An empty file.</Text>}
      {file.note === '' && lines.length === 0 && file.isEditing && (
        <Button key="line-first" {...chip(m)} label="add a first line" onPress={() => act.editLine({ kind: 'insert', line: 0 })} />
      )}
      {!file.isEditing && shown.length > 0 && (
        <Code source={shown.map(shownLine).join('\n')} path={file.path} startLine={file.top + 1} />
      )}
      {file.isEditing &&
        shown.length > 0 &&
        group(
          kit,
          m,
          shown.map((line, at) => {
            const number = file.top + at + 1

            return (
              <Box key={`row:line:${number}`} flexDirection="row" {...rowHover(m)}>
                <Box flexShrink={0} width={digits + 1}>
                  <Text {...(number === file.line ? { color: m.colors.accent, bold: true } : { dimColor: true })}>
                    {String(number).padStart(digits)}
                  </Text>
                </Box>
                <Box flexShrink={1} minWidth={0}>
                  <Button
                    key={`line:${number}`}
                    plain
                    label={clipEnd(indented(shownLine(line)), m.isTerminal ? Math.max(8, m.width - digits - 6) : 200) || ' '}
                    onPress={() => act.pickLine(number)}
                  />
                </Box>
              </Box>
            )
          }),
          0,
        )}
    </Box>
  )
}
