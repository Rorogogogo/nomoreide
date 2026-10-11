import type { RenderElement } from 'claude-code'

import type { EditView, Entry, OpenFile, Search } from '../../types'
import { EDIT_LINES, MAX_EDITOR_CHARS, blockLift, blockRoom, VIEW_LINES, familyOf, holdsChanges, linesOf, shownLine, statusOf, tagOf } from '../files'
import { highlight, sliceTokens } from '../highlight'
import { clipEnd, clipStart, splitPath } from '../text'
import { GLYPH, TOKEN_TONE } from '../tokens'
import {
  drafts,
  MAX_ROWS,
  NARROW,
  chip,
  fit,
  gitLetter,
  group,
  heading,
  indented,
  kind,
  more,
  quiet,
  rowHover,
  rule,
  space,
  twice,
} from './chrome'
import type { Actions, Kit, Model } from './model'

/** A path as the pane names it: from the session's folder down. */
const within = (path: string, m: Model): string =>
  path === m.workspace ? '' : path.startsWith(`${m.workspace}/`) ? path.slice(m.workspace.length + 1) : path

/** How many lines the pane shows of a file being edited before the editor has said what it shows. */
const EDIT_PAGE = 28

/** How many lines the block shows of a file being edited: what the editor laid over it must cover. */
const editRows = (file: OpenFile, view: EditView | null, lines: readonly string[]): number =>
  view !== null && view.path === file.path ? view.lines.length : Math.min(EDIT_PAGE, lines.length)

/**
 * The editor's lines as the block is handed them; the file's own top before its first key.
 * The cursor is not in them: the editor draws it itself, laid over the character it stands on.
 */
function editing(file: OpenFile, view: EditView | null, lines: readonly string[], room: number): string {
  const shown = view !== null && view.path === file.path ? view.lines : lines.slice(0, EDIT_PAGE).map(shownLine)

  return shown.map(line => line.slice(0, room)).join('\n')
}

/** The session's folder, a level at a time: folders open, files are read. */
export function browser(kit: Kit, m: Model, act: Actions): RenderElement {
  const { Box, Text, Button, Input } = kit
  const listing = m.listing
  const field = Input !== undefined && (
    <Input
      key="file-search"
      label="search"
      placeholder="a file's name, or words in files"
      {...(m.search === null ? {} : { value: m.search.query })}
      submitLabel="search"
      onSubmit={query => act.searchFiles(query)}
    />
  )
  if (m.search !== null) return results(kit, m, m.search, act, field)
  if (listing === null) return quiet(kit, m, GLYPH.off, 'Reading the folder', 'One moment.')
  const here = within(listing.path, m)
  const one = (entry: Entry): RenderElement => {
    const isDir = entry.kind === 'dir'
    const path = `${listing.path}/${entry.name}`

    return (
      <Box key={`row:entry:${entry.name}`} flexDirection="row" alignItems="center" {...rowHover(m)}>
        {kind(kit, m, isDir ? 'folder' : 'file', isDir ? undefined : { tag: tagOf(entry.name), family: familyOf(entry.name) })}
        <Box flexShrink={1} minWidth={0}>
          <Button
            key={`entry:${entry.name}`}
            plain
            dimColor={entry.kind === 'other'}
            label={fit(m, isDir ? `${entry.name}/` : entry.name, 8)}
            onPress={() => (isDir ? act.openDir(path) : act.openFile(path))}
          />
        </Box>
        <Box flexGrow={1} />
        {isDir && holdsChanges(m.repos, path) && (
          <Box flexShrink={0} marginLeft={1}>
            <Text color={m.colors.busy}>{GLYPH.changed}</Text>
          </Box>
        )}
        {!isDir && gitLetter(kit, m, statusOf(m.repos, path))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {field}
      {field !== false && space(kit)}
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

/** What a search found: files whose name matches, then lines that hold the words; each opens the file. */
function results(kit: Kit, m: Model, search: Search, act: Actions, field: RenderElement | false): RenderElement {
  const { Box, Text, Button } = kit
  const absolute = (path: string): string => `${m.workspace}/${path}`

  return (
    <Box flexDirection="column">
      {field}
      <Box flexDirection="row" marginTop={m.isTerminal ? 0 : 1}>
        <Button key="search-clear" plain dimColor hotkey="b" label="back to folders" onPress={() => act.clearSearch()} />
      </Box>
      {space(kit)}
      {search.names.length === 0 && search.hits.length === 0 && (
        <Text dimColor>Nothing here is named, or says, “{clipEnd(search.query, 40)}”.</Text>
      )}
      {search.names.length > 0 && heading(kit, 'FILES', search.names.length)}
      {search.names.length > 0 &&
        group(kit, m, search.names.map(path => {
          const { name, dir } = splitPath(path)
          const shown = fit(m, name, 6)

          return (
            <Box key={`row:found:${path}`} flexDirection="row" alignItems="center" {...rowHover(m)}>
              {kind(kit, m, 'file', { tag: tagOf(name), family: familyOf(name) })}
              <Box flexShrink={0}>
                <Button key={`found:${path}`} plain label={shown} onPress={() => act.openFile(absolute(path))} />
              </Box>
              {dir !== '' && (
                <Box flexShrink={1} minWidth={0} marginLeft={2}>
                  <Text dimColor wrap="truncate-end">
                    {m.isTerminal ? clipStart(dir, Math.max(0, m.width - shown.length - 12)) : dir}
                  </Text>
                </Box>
              )}
              <Box flexGrow={1} />
              {gitLetter(kit, m, statusOf(m.repos, absolute(path)))}
            </Box>
          )
        }), 0)}
      {search.names.length > 0 && search.hits.length > 0 && space(kit)}
      {search.hits.length > 0 && heading(kit, 'IN FILES', search.hits.length)}
      {search.hits.length > 0 &&
        group(kit, m, search.hits.map((hit, at) => (
          <Box key={`row:hit:${at}`} flexDirection="column" {...rowHover(m)}>
            <Button
              key={`hit:${hit.path}:${hit.line}`}
              plain
              label={fit(m, hit.text === '' ? '(an empty line)' : hit.text, 2)}
              onPress={() => act.openFile(absolute(hit.path), hit.line)}
            />
            <Box paddingLeft={m.isTerminal ? 0 : 0.5}>
              <Text dimColor wrap="truncate-end">
                {m.isTerminal ? clipStart(`${hit.path}:${hit.line}`, m.width - 6) : `${hit.path}:${hit.line}`}
              </Text>
            </Box>
          </Box>
        )))}
      {search.isCut && <Text dimColor>… more matches than are shown; search for something narrower.</Text>}
    </Box>
  )
}

/**
 * A file: read as highlighted code, or, being edited, as lines that take a
 * press, their parts still coloured. The line pressed becomes a text field
 * where it stands; Enter saves it and goes on to the next, as in an editor.
 */
export function fileView(kit: Kit, m: Model, file: OpenFile, act: Actions): RenderElement {
  const { Box, Text, Button, Code, Input } = kit
  const { name, dir } = splitPath(within(file.path, m))
  const lines = file.note === '' ? linesOf(file.text) : []
  const size = file.isEditing ? EDIT_LINES : VIEW_LINES + file.more
  const shown = lines.slice(file.top, file.top + size)
  const last = Math.min(lines.length, file.top + size)
  const family = familyOf(name)
  // Whether a block comment is open as each shown line starts: read down from the file's top.
  const blocks: boolean[] = []
  if (file.isEditing) {
    let open = false
    lines.slice(0, file.top + size).forEach((line, at) => {
      if (at >= file.top) blocks.push(open)
      open = highlight(shownLine(line), family, open).inBlock
    })
  }
  const gap = m.width < NARROW ? 1 : 2
  const digits = String(last).length
  // A whole-file editor where the surface runs one and the text fits what it is handed.
  const hasEditor = kit.editor !== undefined && file.note === '' && file.text.length <= MAX_EDITOR_CHARS

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={gap}>
        <Button key="back" plain dimColor hotkey="b" label="back" onPress={() => act.closeFile()} />
        <Box flexGrow={1} />
        {file.note === '' && (Input !== undefined || hasEditor) && (
          file.isDirty ? (
            // Leaving with changes unsaved throws them away: asked first.
            twice(kit, m, act, 'discard-edit', 'discard changes', () => act.toggleEdit())
          ) : (
            <Button
              key="edit"
              {...chip(m, false)}
              {...(file.isEditing && hasEditor ? {} : { hotkey: 'e' })}
              label={file.isEditing ? 'done' : 'edit'}
              onPress={() => act.toggleEdit()}
            />
          )
        )}
        <Button
          key="mention"
          {...drafts(m)}
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
          // The editor holds the whole file and scrolls it itself: there is no window to name.
          lines.length === 0 ? '' : file.isEditing && hasEditor ? `${lines.length} lines` : `lines ${file.top + 1}${GLYPH.dash}${last} of ${lines.length}`,
        ]
          .filter(part => part !== '')
          .join(` ${GLYPH.dot} `)}
      </Text>
      {/* A file changed a line at a time is paged. A read grows in place, and the pane's own scroll walks it. */}
      {file.isEditing && !hasEditor && lines.length > size && (
        <Box flexDirection="row" columnGap={gap} marginTop={m.isTerminal ? 0 : 1}>
          {file.top > 0 && <Button key="page-back" {...chip(m)} hotkey="k" label="earlier" onPress={() => act.pageFile(-1)} />}
          {last < lines.length && <Button key="page-on" {...chip(m)} hotkey="j" label="later" onPress={() => act.pageFile(1)} />}
        </Box>
      )}
      {!file.isEditing && file.top > 0 && (
        <Box flexDirection="row" alignItems="center" columnGap={2} marginTop={m.isTerminal ? 0 : 1}>
          <Text dimColor>… {file.top} lines above</Text>
          <Button key="page-back" {...chip(m, false)} hotkey="k" label="show earlier" onPress={() => act.pageFile(-1)} />
        </Box>
      )}
      {rule(kit, m)}
      {file.note !== '' && <Text dimColor>{file.note}</Text>}
      {file.note === '' && lines.length === 0 && !file.isEditing && <Text dimColor>An empty file.</Text>}
      {file.isEditing && hasEditor && !m.isTerminal && (
        // Off a cell grid the pane draws the editor's text, in the block a file being read is drawn in.
        // A column stretches what stands in it: the block is the pane's full width, whatever its lines come to.
        <Box marginTop={1} flexDirection="column" width="100%">
          <Code source={editing(file, m.editView, lines, blockRoom(m.width, m.editView?.path === file.path ? m.editView.top + m.editView.lines.length : Math.min(lines.length, EDIT_PAGE)))} path={file.path} startLine={(m.editView?.path === file.path ? m.editView.top : 0) + 1} />
        </Box>
      )}
      {file.isEditing && hasEditor && (
        // There the editor is laid over that block, its own room empty, so a click on the
        // text is a click in the editor: what hands it the keys, and puts the cursor there.
        <Box flexDirection="column" {...(m.isTerminal ? {} : { width: '100%', marginTop: -blockLift(editRows(file, m.editView, lines)) })}>
          {kit.editor?.({
            path: file.path,
            text: file.text,
            rev: file.mtimeMs,
            family,
            rows: m.isTerminal ? m.rows : 0,
            width: m.width,
            isRemote: !m.isTerminal,
          })}
        </Box>
      )}
      {file.note === '' && lines.length === 0 && file.isEditing && !hasEditor && (
        <Button key="line-first" {...chip(m)} label="add a first line" onPress={() => act.editLine({ kind: 'insert', line: 0 })} />
      )}
      {!file.isEditing && shown.length > 0 && (
        <Code source={shown.map(shownLine).join('\n')} path={file.path} startLine={file.top + 1} />
      )}
      {!file.isEditing && last < lines.length && (
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          {more(kit, lines.length - last, 'lines')}
          <Button key="page-on" {...chip(m, false)} hotkey="m" label="show more" onPress={() => act.pageFile(1)} />
        </Box>
      )}
      {file.isEditing &&
        !hasEditor &&
        shown.length > 0 &&
        group(
          kit,
          m,
          shown.map((line, at) => {
            const number = file.top + at + 1
            const text = shownLine(line)
            const gutter = (
              <Box flexShrink={0} width={digits + 1}>
                <Text {...(number === file.line ? { color: m.colors.accent, bold: true } : { dimColor: true })}>
                  {String(number).padStart(digits)}
                </Text>
              </Box>
            )
            // The line being changed is a text field where it stands, as a line in an editor is.
            if (number === file.line && Input !== undefined) {
              return (
                <Box key={`row:line:${number}`} flexDirection="column">
                  <Box flexDirection="row" alignItems="center">
                    {gutter}
                    <Box flexGrow={1} flexShrink={1} minWidth={0}>
                      <Input
                        key={`line-text:${number}`}
                        value={text}
                        placeholder="an empty line"
                        submitLabel="save"
                        autoFocus
                        onSubmit={value => act.editLine({ kind: 'replace', line: number, value })}
                      />
                    </Box>
                  </Box>
                  <Box flexDirection="row" columnGap={gap} paddingLeft={digits + 1}>
                    <Button key="line-insert" {...chip(m)} label="new line below" onPress={() => act.editLine({ kind: 'insert', line: number })} />
                    <Button key="line-delete" {...chip(m)} label="delete line" onPress={() => act.editLine({ kind: 'delete', line: number })} />
                    <Box flexGrow={1} />
                    <Button key="line-cancel" {...chip(m)} label="cancel" onPress={() => act.pickLine(null)} />
                  </Box>
                </Box>
              )
            }
            const room = m.isTerminal ? Math.max(8, m.width - digits - 6) : 200
            const read = highlight(text.replace(/\t/g, '  '), family, blocks[at] ?? false)
            const parts = sliceTokens(read.tokens, 0, room)

            return (
              <Box key={`row:line:${number}`} flexDirection="row" {...rowHover(m)}>
                {gutter}
                <Box flexShrink={1} minWidth={0}>
                  {/* A press holds strings and coloured runs of text: the line's parts keep their colours. */}
                  <Button key={`line:${number}`} plain onPress={() => act.pickLine(number)}>
                    {parts.length === 0
                      ? ' '
                      : parts.map((part, place) =>
                          part.kind === 'plain' ? (
                            // Leading spaces are kept: a surface that sets type folds plain ones away.
                            place === 0 ? indented(part.text) : part.text
                          ) : (
                            <Text color={TOKEN_TONE[part.kind]} {...(part.kind === 'comment' ? { italic: true } : {})}>
                              {place === 0 ? indented(part.text) : part.text}
                            </Text>
                          ),
                        )}
                    {text.length > room ? '…' : ''}
                  </Button>
                </Box>
              </Box>
            )
          }),
          0,
        )}
    </Box>
  )
}
