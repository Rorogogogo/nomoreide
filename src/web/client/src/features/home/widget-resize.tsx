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

/**
 * How close to the grid's right edge counts as being at it.
 *
 * The grid pulls itself a pixel wider than its container to hide the rightmost
 * hairline (`WidgetGrid`), so its right edge sits one pixel past anywhere a
 * cursor can actually be. Two pixels of slack costs nothing and is the
 * difference between "drag to the edge" working and never firing.
 */
const EDGE = 2;

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
  /** The grid's own left edge — where a column index is measured from. */
  gridLeft: number;
  /** And its right edge: as far right as a cursor can be asked to go. */
  gridRight: number;
  left: number;
  top: number;
  width: number;
  height: number;
  span: WidgetSpan;
  rows: number;
}

/** The rectangle a width resolves to, in columns of the grid it is drawn on. */
export interface WidgetBox {
  column: number;
  span: number;
  lanes: number;
}

/**
 * The grip: a corner mark, not a handle.
 *
 * It sits at the corner of the *cell* — the rectangle with the rules around it,
 * the one the reader can see. It used to sit on the body, on the argument that
 * the body is what a height sizes; what that produced was a mark floating in the
 * middle of any panel the packer had stretched, with no line under it to be the
 * corner of. A grip has to be on the thing it appears to move.
 *
 * Which is why the drag starts from the cell's bottom too, and not from a stored
 * height that may be shorter than what is on screen. Grab a corner, move it a
 * row, and the panel is a row taller than it looked — the stretch the packer
 * added is adopted rather than discarded. What that costs is what it always
 * cost: dragging *up* inside space the packer sealed (`home-pack.ts`) changes
 * the stored height and nothing visible, because the panel below spans the
 * column and cannot rise. That was equally true of the grip on the body; it is a
 * property of the packing, and the only honest place to hit it is the corner
 * that is actually there.
 *
 * Unlike the width-only edge it replaced, it is not `xl`-only. Below that
 * breakpoint the 12-column grid collapses and a width has nowhere to show
 * itself, but a height is plain pixels and means the same thing at every window
 * size — and a grip that vanished on a narrow window would be a resize you
 * could lose by making the window smaller.
 */
export function WidgetResizeGrip({
  onFrame,
  onSize,
  resolveBox,
  span,
  title,
}: {
  onFrame: (frame: ResizeFrame | null) => void;
  onSize: (size: WidgetSize) => void;
  /**
   * The rectangle the row would actually give, for a width the drag is asking
   * for.
   *
   * Columns come out of the neighbours, and a row of two cannot give one panel
   * eleven of them. Running the request through the same arithmetic the commit
   * will use is what keeps the frame from promising something that will not
   * survive the drop — the *position* as much as the width, because which
   * neighbour gives up its columns decides which way the panel grows.
   */
  resolveBox: (span: WidgetSpan) => WidgetBox;
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
    // Two boxes, because they answer different questions. The body is where the
    // panel begins — its top is where a height is measured from and its left is
    // where a width is — and the cell is where the panel *ends*, which is where
    // the grip is and so where the drag starts from.
    const cell = grip.parentElement;
    const body = cell?.querySelector("[data-widget-body]");
    const grid = grip.closest("[data-widget-grid]");
    if (!body || !cell || !grid) return null;
    const rect = body.getBoundingClientRect();
    const ruler = grid.getBoundingClientRect();
    // What is on screen, top of the content to bottom of the slot — the stretch
    // the packer may have added included, since that is the corner being held.
    const shown = cell.getBoundingClientRect().bottom - rect.top;
    return {
      // The grid is the ruler: one twelfth of it is one column, whatever the
      // window is doing. Read once, at pointer-down, so nothing that happens
      // during the drag can move the origin underneath the cursor.
      column: ruler.width / GRID_COLUMNS,
      gridLeft: ruler.left,
      gridRight: ruler.right,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: shown,
      span,
      // Where a vertical drag starts from, and it is what is on screen rather
      // than what is stored — otherwise the first pixel of movement jumps the
      // frame to a height the panel is not currently drawn at. It is also what
      // keeps a straight-sideways drag from writing a height: the row it lands
      // on is the row it began at, so the axis nobody moved stays unwritten.
      rows: clampHeight(shown / HOME_ROW_PX),
    };
  };

  const targetOf = (event: { clientX: number; clientY: number }, start: Origin) => {
    const asked = (event.clientX - start.left) / start.column;
    return {
      // Dragged off the end of the page: ask for the whole grid.
      //
      // Without this the widest a shared row can offer is nine columns, and the
      // last inches of the gesture do nothing at all — the frame stops three
      // quarters across while the cursor keeps going, which reads as a stuck
      // control rather than as a rule. `resize` turns the request into a row of
      // its own (`home-layout.ts`), so what the frame promises is real.
      //
      // It has to be an actual widening to count. A panel whose right edge is
      // already the page's begins the drag at the edge, and a twitch there must
      // not be read as a demand for everything. `EDGE` is for the grid's own
      // `-mr-px`, which puts its right edge one pixel past anything pointable.
      span:
        event.clientX >= start.gridRight - EDGE && asked > start.span
          ? GRID_COLUMNS
          : clampSpan(asked),
      rows: clampHeight((event.clientY - start.top) / HOME_ROW_PX),
    };
  };

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
      const box = resolveBox(target.span);
      const width = start.column * GRID_COLUMNS;
      return {
        // Placed against the grid rather than against where the panel is now: a
        // panel taking columns from its left-hand neighbour keeps its right edge
        // and moves its left one, and a frame anchored to the old left edge
        // would draw the growth on the wrong side.
        left: start.gridLeft + (box.column / box.lanes) * width,
        top: start.top,
        width: (box.span / box.lanes) * width,
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
      const next = clampSpan(span + horizontal);
      // A step that changes nothing, still going right, is the keyboard at the
      // same wall the pointer hits at the edge of the page — and it means the
      // same thing there: take the row. Without this the widest a key can reach
      // is nine columns, and full width would be a mouse-only state.
      const stuck = horizontal > 0 && resolveBox(next).span === span;
      onSize({ span: stuck ? GRID_COLUMNS : next });
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

/*
 * The frame this drag draws lives in `widget-grid.tsx` as `WidgetDragFrame`.
 * The drop gesture makes the same promise — *this is what you will get* — and
 * two frames that looked slightly different would read as two different kinds
 * of answer, so there is one component and both gestures use it.
 */
