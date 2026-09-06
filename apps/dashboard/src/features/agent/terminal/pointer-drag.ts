import type { MutableRefObject, PointerEvent as ReactPointerEvent } from "react";

/**
 * Start a pointer drag on `window`, replacing any drag already in flight.
 *
 * The dock has three drags — resizing it, moving it between edges, and moving
 * the split divider — and each one had the same fifteen lines around its two
 * real handlers: capture the pointer, register `pointermove`/`pointerup`,
 * remember a cleanup so a second drag can cancel the first, and unregister on
 * release. That is the part collected here.
 *
 * The listeners go on `window`, not the element, so a drag that leaves the
 * handle still tracks; `setPointerCapture` keeps the element's own events
 * coherent while it does. `cleanupRef` is called before the new drag starts,
 * so a pointer sequence that never delivered its `pointerup` — a dropped
 * event, a re-render mid-drag — cannot leave listeners behind.
 */
export function beginPointerDrag(
  event: ReactPointerEvent<Element>,
  cleanupRef: MutableRefObject<(() => void) | null>,
  handlers: {
    move: (event: PointerEvent) => void;
    /** Runs on release, before the listeners come off. */
    up?: (event: PointerEvent) => void;
  },
): void {
  event.preventDefault();
  event.currentTarget.setPointerCapture?.(event.pointerId);

  const move = (next: PointerEvent) => handlers.move(next);
  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    cleanupRef.current = null;
  };
  const up = (next: PointerEvent) => {
    handlers.up?.(next);
    cleanup();
  };

  cleanupRef.current?.();
  cleanupRef.current = cleanup;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
