import type { ClientModule } from 'claude-code'

import { applyKey, bufferOf, scrolled, textOf } from './edit-buffer'
import type { Buffer } from './edit-buffer'
import type { Family } from './files'
import { highlight, sliceTokens } from './highlight'
import type { Token } from './highlight'
import { TOKEN_TONE } from './tokens'

// The file editor: a surface module, so keys and clicks reach it as they
// happen. A cursor in the text, typing where it stands, the arrows, Enter and
// Backspace across lines, a click to put the cursor somewhere, ctrl+s (or
// its button) to save and ctrl+u to undo. The file itself is written by the hooks module, which has the
// engine: saving posts the text to it.

export type EditorProps = {
  path: string
  text: string
  /** The file's time of writing as the hooks module read it: a new one means new text on disk. */
  rev: number
  family: Family
  /** The pane's rows where it has a fixed height, and its width in cells; 0 where unknown. */
  rows: number
  width: number
}

type State = {
  rev: number
  buffer: Buffer
  top: number
  left: number
  isDirty: boolean
  /** Buffers gone back to with ctrl+z, the latest last. */
  undo: Buffer[]
}

/** Rows the pane's own header takes above the editor, and the status line under it. */
const CHROME_ROWS = 11
const MIN_ROWS = 8
const DEFAULT_ROWS = 28
const MAX_UNDO = 200

const Editor: ClientModule<EditorProps, State> = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  const held = surface.state
  // New text on disk replaces the buffer, unless the person has changes of their
  // own; text that is what the buffer already holds is this editor's own save.
  const isFresh =
    held === undefined || (held.rev !== props.rev && (!held.isDirty || props.text === textOf(held.buffer)))
  const state: State = isFresh
    ? {
        rev: props.rev,
        buffer: bufferOf(props.text, held?.buffer.row ?? 0, held?.buffer.col ?? 0),
        top: held?.top ?? 0,
        left: held?.left ?? 0,
        isDirty: false,
        undo: [],
      }
    : held
  const { buffer } = state
  const digits = String(buffer.lines.length).length
  const page = Math.max(MIN_ROWS, props.rows > 0 ? props.rows - CHROME_ROWS : DEFAULT_ROWS)
  const room = Math.max(10, (surface.columns > 0 ? surface.columns : props.width > 0 ? props.width : 80) - digits - 2)

  const show = (next: Buffer, more: Partial<State> = {}): void => {
    surface.setState({
      ...state,
      ...more,
      buffer: next,
      top: scrolled(state.top, next.row, page),
      left: scrolled(state.left, next.col, room),
    })
  }
  const save = (): void => {
    surface.post({ type: 'save', path: props.path, text: textOf(buffer), rev: state.rev })
  }

  const undo = (): void => {
    const before = state.undo.at(-1)
    if (before !== undefined) show(before, { undo: state.undo.slice(0, -1), isDirty: true })
  }

  surface.onKey(event => {
    if (event.ctrl === true && event.key === 's') return save()
    // Not ctrl+z: a terminal takes that for itself and suspends the program.
    if (event.ctrl === true && event.key === 'u') return undo()
    const next = applyKey(buffer, event, page)
    if (next === undefined) return
    if (next.lines === buffer.lines) return show(next)
    // The first change says so to the hooks module, which guards the way out.
    if (!state.isDirty) surface.post({ type: 'dirty', path: props.path })
    show(next, { isDirty: true, undo: [...state.undo, buffer].slice(-MAX_UNDO) })
  })
  surface.onPointer(event => {
    if (event.type !== 'down') return
    const row = Math.max(0, Math.min(buffer.lines.length - 1, state.top + Math.floor(event.y)))
    const col = Math.max(0, Math.min((buffer.lines[row] ?? '').length, state.left + Math.floor(event.x) - digits - 1))
    show({ lines: buffer.lines, row, col })
  })

  // Whether a block comment is open as each line in view starts: read down from the top.
  const blocks: boolean[] = []
  let open = false
  buffer.lines.slice(0, state.top + page).forEach((line, at) => {
    if (at >= state.top) blocks.push(open)
    open = highlight(line, props.family, open).inBlock
  })
  const run = (tokens: readonly Token[], from: number, to: number) =>
    sliceTokens(tokens, from, to).map(token =>
      token.kind === 'plain' ? (
        <Text>{token.text}</Text>
      ) : (
        <Text color={TOKEN_TONE[token.kind]} {...(token.kind === 'comment' ? { italic: true } : {})}>
          {token.text}
        </Text>
      ),
    )
  const end = state.left + room

  return (
    <Box flexDirection="column">
      {buffer.lines.slice(state.top, state.top + page).map((line, at) => {
        const row = state.top + at
        const { tokens } = highlight(line, props.family, blocks[at] ?? false)
        const isHere = row === buffer.row && buffer.col >= state.left && buffer.col < end

        return (
          <Box key={`line:${row}`} flexDirection="row">
            <Text dimColor={row !== buffer.row} bold={row === buffer.row}>
              {`${String(row + 1).padStart(digits)} `}
            </Text>
            {isHere ? run(tokens, state.left, buffer.col) : run(tokens, state.left, end)}
            {isHere && <Text inverse>{line[buffer.col] ?? ' '}</Text>}
            {isHere && run(tokens, buffer.col + 1, end)}
          </Box>
        )
      })}
      <Box flexDirection="row" marginTop={1} columnGap={2}>
        <Text dimColor={!state.isDirty}>{state.isDirty ? '● unsaved' : 'saved'}</Text>
        <Text dimColor>{`line ${buffer.row + 1}, column ${buffer.col + 1}`}</Text>
        <Box flexGrow={1} />
        {/* A terminal can keep a chord for itself; a press always works. */}
        {state.undo.length > 0 && <Button key="undo" plain dimColor label="undo (ctrl+u)" onPress={() => undo()} />}
        {state.isDirty && <Button key="save" plain label="save (ctrl+s)" onPress={() => save()} />}
        {!state.isDirty && state.undo.length === 0 && <Text dimColor>click in the text to type</Text>}
      </Box>
    </Box>
  )
}

export default Editor
