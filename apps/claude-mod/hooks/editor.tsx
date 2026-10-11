import type { ClientModule } from 'claude-code'

import { bufferOf, scrolled, textOf } from './edit-buffer'
import type { Buffer } from './edit-buffer'
import { BLOCK, blockCodeAt, blockRoom, blockRows } from './files'
import type { Family } from './files'
import { highlight, sliceTokens } from './highlight'
import type { Token } from './highlight'
import { TOKEN_TONE } from './tokens'
import { VIM_START, vimKey } from './vim'
import type { Vim } from './vim'

// The file editor: a surface module, so keys and clicks reach it as they
// happen. A cursor in the text and Vim's keys over it: a normal mode that moves
// and cuts, an insert mode that types, ctrl+s (or its button) to save and `u`
// to undo. The file itself is written by the hooks module, which has the
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
  /**
   * Whether the pane draws the text. Where a surface sets type proportionally
   * (the desktop app) code needs the surface's own code block to keep its
   * columns, and a surface module cannot draw one there: so this one keeps
   * the buffer and the keys, tells the pane what to show after each key, and
   * draws only its own status line.
   */
  isRemote: boolean
}

type State = {
  rev: number
  buffer: Buffer
  top: number
  left: number
  isDirty: boolean
  /** Buffers gone back to with ctrl+z, the latest last. */
  undo: Buffer[]
  vim: Vim
  /** Whether a key has reached this editor yet: until one does, it says how to give it the keys. */
  hasKeys: boolean
  /** Whether the cursor is in the lit half of its blink, and how many blinks have passed since the last key. */
  isLit: boolean
  idle: number
}

/** Rows the pane's own header takes above the editor, and the status line under it. */
const CHROME_ROWS = 11
const MIN_ROWS = 8
const DEFAULT_ROWS = 28
const MAX_UNDO = 200
/** The cursor's blink where the pane draws it: half a beat, and how many beats after the last key it goes on for. */
const BLINK_MS = 530
const BLINK_BEATS = 60
/** The cursor laid over the pane's text: a tint the character shows through in normal mode, a thin bar while typing. */
const CURSOR = { tint: 'rgba(76, 154, 141, 0.42)', bar: '#4C9A8D', barPx: 2 }

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
        vim: held?.vim ?? VIM_START,
        hasKeys: held?.hasKeys ?? false,
        isLit: true,
        idle: 0,
      }
    : held
  const { buffer } = state
  const digits = String(buffer.lines.length).length
  const page = Math.max(MIN_ROWS, props.rows > 0 ? props.rows - CHROME_ROWS : DEFAULT_ROWS)
  // The last line number in view: what sets how wide the block's numbers are.
  const last = Math.min(buffer.lines.length, state.top + page)
  const room = props.isRemote
    ? blockRoom(props.width, last)
    : Math.max(10, (surface.columns > 0 ? surface.columns : props.width > 0 ? props.width : 80) - digits - 2)

  const show = (next: Buffer, more: Partial<State> = {}): void => {
    const top = scrolled(state.top, next.row, page)
    surface.setState({
      ...state,
      hasKeys: true,
      isLit: true,
      idle: 0,
      ...more,
      buffer: next,
      top,
      left: scrolled(state.left, next.col, room),
    })
    if (!props.isRemote) return
    // One post a frame reaches the hooks module, so what is shown and that there are changes go as one.
    // The block wraps a line wider than its room, which would put every line under it a row
    // down from where a click is read: so each line goes cut to the room, from the same column.
    const left = scrolled(state.left, next.col, room)
    surface.post({
      type: 'view',
      path: props.path,
      top,
      row: next.row,
      col: next.col - left,
      lines: next.lines.slice(top, top + page).map(line => line.slice(left, left + room)),
      isDirty: more.isDirty ?? state.isDirty,
    })
  }
  // The blink is this editor's own clock, started once, and only this editor is drawn again for
  // it. It runs while keys have been reaching it, which is what says the keys are here; left
  // alone for half a minute the cursor stays lit.
  if (held === undefined) surface.setState(state)
  if (held === undefined && props.isRemote) {
    surface.every(BLINK_MS, () => {
      const now = surface.state
      if (now === undefined || !now.hasKeys || (now.idle >= BLINK_BEATS && now.isLit)) return
      const isLit = now.idle >= BLINK_BEATS ? true : !now.isLit
      surface.setState({ ...now, isLit, idle: now.idle + 1 })
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
    // The keys are Vim's. ctrl+u is half a page up in normal mode, as Vim has it, and `u` the
    // undo there; while typing, ctrl+u undoes (not ctrl+z: a terminal suspends the program on it).
    if (event.ctrl === true && event.key === 'u' && state.vim.mode === 'insert') return undo()
    const step = vimKey(buffer, state.vim, event, page)
    if (step === undefined) return
    if (step.ask === 'undo') return undo()
    if (step.buffer.lines === buffer.lines) return show(step.buffer, { vim: step.vim })
    // The first change says so to the hooks module, which guards the way out.
    if (!state.isDirty && !props.isRemote) surface.post({ type: 'dirty', path: props.path })
    show(step.buffer, { vim: step.vim, isDirty: true, undo: [...state.undo, buffer].slice(-MAX_UNDO) })
  })
  surface.onPointer(event => {
    // Over the pane's code block a click only hands this editor the keys: the cursor is moved with them.
    if (event.type !== 'down' || props.isRemote) return
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
      {props.isRemote && (
        // The room that lies over the pane's code block, so that a click anywhere on the text is a
        // click in this editor. The cursor is drawn in it, over the character it stands on: the
        // text under it is the pane's and never moves for it.
        <Box height={blockRows(Math.min(page, buffer.lines.length - state.top))} flexShrink={0} flexDirection="column">
          <Box height={(BLOCK.above + (buffer.row - state.top) * BLOCK.line) / BLOCK.row} flexShrink={0} />
          <Box flexDirection="row" flexShrink={0}>
            <Box width={(blockCodeAt(last) + (buffer.col - state.left) * BLOCK.char) / BLOCK.cell} flexShrink={0} />
            {state.isLit !== false && (
              <Box
                width={(state.vim.mode === 'insert' ? CURSOR.barPx : BLOCK.char) / BLOCK.cell}
                height={BLOCK.line / BLOCK.row}
                flexShrink={0}
                backgroundColor={state.vim.mode === 'insert' ? CURSOR.bar : CURSOR.tint}
              />
            )}
          </Box>
        </Box>
      )}
      {(props.isRemote ? [] : buffer.lines.slice(state.top, state.top + page)).map((line, at) => {
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
        <Text bold={state.vim.mode === 'insert'} dimColor={state.vim.mode === 'normal'}>
          {state.vim.mode === 'insert' ? 'INSERT (jk to leave)' : state.vim.pending === '' ? 'NORMAL (i to type)' : `NORMAL ${state.vim.pending}`}
        </Text>
        <Text dimColor>{`line ${buffer.row + 1}, column ${buffer.col + 1}`}</Text>
        <Box flexGrow={1} />
        {/* A terminal can keep a chord for itself; a press always works. */}
        {state.undo.length > 0 && <Button key="undo" plain dimColor label="undo (u)" onPress={() => undo()} />}
        {state.isDirty && <Button key="save" plain label="save (ctrl+s)" onPress={() => save()} />}
        {props.isRemote && !state.hasKeys && <Text dimColor>click the text, then type</Text>}
        {!props.isRemote && !state.isDirty && state.undo.length === 0 && <Text dimColor>click in the text to type</Text>}
      </Box>
    </Box>
  )
}

export default Editor
