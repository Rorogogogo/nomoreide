// The desktop app gives a pane the keyboard on the first click in it and
// raises that click as a focus move alone, never a press. Whether a focus
// move was such a click, and whether a press that follows is its echo, are
// decided here, apart from the engine, so both can be tested.

/** How long after answering a focus as a press the same button's own press is taken as its echo. */
export const ECHO_MS = 600

export type FocusMove = { origin: { kind: string }; element?: string | undefined }

/**
 * Whether a focus move is a click that only brought the keyboard: the
 * person's, on one of the pane's own elements, in a desktop pane that did
 * not hold the keyboard. A cell grid raises the press itself.
 */
export function isFocusOnlyClick(
  pane: { isDesktopFocused: boolean | undefined; hasTerminal: boolean },
  move: FocusMove,
): boolean {
  return (
    pane.isDesktopFocused === false &&
    !pane.hasTerminal &&
    move.origin.kind === 'person' &&
    move.element !== undefined
  )
}

/** Whether a press is the surface raising, late, a click already answered from its focus move. */
export function isEcho(answered: { key: string; at: number }, element: string | undefined, now: number): boolean {
  return answered.key !== '' && element === answered.key && now - answered.at < ECHO_MS
}
