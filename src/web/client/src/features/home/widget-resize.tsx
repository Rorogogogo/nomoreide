import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useT } from "@/lib/i18n";
import { clampHeight, clampSpan, GRID_COLUMNS, HOME_ROW_PX } from "./home-layout";
import type { WidgetSpan } from "./widget-types";

/**
 * Resizing a panel: one corner, and a frame that shows the answer before it is
 * committed.
 *
 * This is the third attempt, and each one lost a control:
 *
 * 1. Three preset buttons labelled `4 6 12`, which the first person to see them
 *    asked the meaning of. A width is not a number you should have to convert
 *    from.
 * 2. A draggable right edge — right idea, wrong feel. It re-laid the whole page
 *    on every pointer move, so the panel under the cursor pushed its neighbours
 *    onto other rows mid-gesture, and it was one axis, which is half a resize.
 * 3. Edges *and* a corner, which was one grip too many: the corner already does
 *    what both edges do, and three targets on every panel is a control surface
 *    where there should be a page.
 *
 * What survives is the gesture every window manager has had since 1984, and the
 * two properties the earlier passes were missing: **nothing reflows until you
 * let go** (what moves is a frame, exactly the way the agent dock's splitter
 * shows where it will land), and **only the axis you actually moved is
 * written** — a drag straight sideways must not quietly pin a height, which is
 * the one thing the corner could get wrong that two edges could not.
 */

/** The rectangle the drag is currently asking for, in viewport coordinates. */
export interface ResizeFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What a commit changes. An omitted axis is one the gesture did not move. */
export interface WidgetSize {
  span?: WidgetSpan;
  height?: number | null;
}

/** Where the drag began: the ruler, the panel's corner, and its size then. */
interface Origin {
  column: number;
  left: number;
  top: number;
  width: number;
  height: number;
  span: WidgetSpan;
  rows: number;
}

/**
 * The grip: a corner mark, not a handle.
 *
 * It lives inside the panel's *body*, which is the box a height actually sizes,
 * so the grip always sits on the corner you are about to move rather than on
 * the bottom of a cell that stretched to fit a taller neighbour.
 *
 * Unlike the width-only edge it replaced, it is not `xl`-only. Below that
 * breakpoint the 12-column grid collapses and a width has nowhere to show
 * itself, but a height is plain pixels and means the same thing at every window
 * size — and a grip that vanished on a narrow window would be a resize you
 * could lose by making the window smaller.
 */
export function WidgetResizeGrip({
  height,
  onFrame,
  onSize,
  span,
  title,
}: {
  height: number | null;
  onFrame: (frame: ResizeFrame | null) => void;
  onSize: (size: WidgetSize) => void;
  span: WidgetSpan;
  title: string;
}) {
  const t = useT();
  const release = useRef<(() => void) | null>(null);
  const label = t("home.edit.size", { name: title });

  // A drag that ends outside the grip still has to end. Listening on the window
  // rather than relying on `setPointerCapture` means the release is caught
  // wherever the cursor happens to be, and a pointer id the browser will not
  // let us capture cannot strand the panel mid-resize.
  useEffect(() => () => release.current?.(), []);

  const measure = (grip: HTMLElement): Origin | null => {
    // The grip's parent is the body — the box a height sizes, and the box whose
    // left edge a width is measured from.
    const body = grip.parentElement;
    const grid = grip.closest("[data-widget-grid]");
    if (!body || !grid) return null;
    const rect = body.getBoundingClientRect();
    return {
      // The grid is the ruler: one twelfth of it is one column, whatever the
      // window is doing. Read once, at pointer-down, so nothing that happens
      // during the drag can move the origin underneath the cursor.
      column: grid.getBoundingClientRect().width / GRID_COLUMNS,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      span,
      // A panel with no stored height still has a real one on screen, and that
      // is where a vertical drag has to start from — otherwise the first pixel
      // of movement jumps the frame to some default the user never chose.
      rows: height ?? clampHeight(rect.height / HOME_ROW_PX),
    };
  };

  const targetOf = (event: { clientX: number; clientY: number }, start: Origin) => ({
    span: clampSpan((event.clientX - start.left) / start.column),
    rows: clampHeight((event.clientY - start.top) / HOME_ROW_PX),
  });

  const begin = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = measure(event.currentTarget);
    if (!start) return;
    event.preventDefault();

    // The frame is up before the first move, drawn at the panel's true rect
    // rather than at the nearest snap: the gesture says what it will do from
    // the moment it starts, and a frame that jumped 8px on mousedown would read
    // as the resize having already happened.
    onFrame({ left: start.left, top: start.top, width: start.width, height: start.height });
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "nwse-resize";

    const frameFor = (moved: { clientX: number; clientY: number }) => {
      const target = targetOf(moved, start);
      return {
        left: start.left,
        top: start.top,
        width: target.span * start.column,
        height: target.rows * HOME_ROW_PX,
      };
    };
    const move = (moved: PointerEvent) => onFrame(frameFor(moved));
    const end = (ended: PointerEvent) => {
      release.current?.();
      release.current = null;
      onFrame(null);
      const target = targetOf(ended, start);
      // Writing preferences on every pointermove would put a `localStorage`
      // write behind every frame of the drag; only the result is saved.
      //
      // And only the axes that moved: a panel with no height is fitting its
      // content, which is a state worth keeping. Compare against where the drag
      // *started* — a straight-sideways drag lands on the height it began at
      // and so writes nothing, leaving the panel free to grow with what it
      // holds instead of frozen at whatever it happened to measure that day.
      const size: WidgetSize = {};
      if (target.span !== start.span) size.span = target.span;
      if (target.rows !== start.rows) size.height = target.rows;
      if (size.span !== undefined || size.height !== undefined) onSize(size);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    release.current = () => {
      document.body.style.cursor = previousCursor;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  };

  /**
   * Arrow keys do the same job a step at a time, one axis per key. A resize
   * that only answers to a mouse is a control half the users of this page
   * cannot reach, and the steps are the units the drag snaps to, so the two
   * agree exactly.
   */
  const keys = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const horizontal = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const vertical = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (horizontal) {
      event.preventDefault();
      onSize({ span: clampSpan(span + horizontal) });
      return;
    }
    if (vertical) {
      event.preventDefault();
      const start = measure(event.currentTarget);
      if (start) onSize({ height: clampHeight(start.rows + vertical) });
    }
  };

  return (
    <button
      aria-label={label}
      className="absolute bottom-0 right-0 z-10 flex size-3.5 cursor-nwse-resize touch-none items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      /* Double-click gives a height back to the content, the way the dock's own
         grip resets its width — the only way out of a height once one is set. */
      onDoubleClick={() => onSize({ height: null })}
      onKeyDown={keys}
      onPointerDown={begin}
      title={label}
      type="button"
    >
      <span
        aria-hidden
        className="size-1.5 rounded-[1px] border-b border-r border-border transition-colors group-hover/widget:border-muted-foreground/60"
      />
    </button>
  );
}

/**
 * The frame: where the panel will be when you let go.
 *
 * Fixed rather than absolute so nothing that clips the grid can clip it — the
 * grid hides its own overflow to keep the rightmost hairline off the page edge,
 * and a frame for a panel dragged to full width has to be allowed past that.
 *
 * It is drawn as an outline over the untouched page, which is the whole point:
 * the layout you are comparing against is still the layout you had.
 */
export function WidgetResizeFrame({ frame }: { frame: ResizeFrame | null }) {
  if (!frame) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-50 border border-dashed border-primary/70 bg-primary/5"
      style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
    />
  );
}
