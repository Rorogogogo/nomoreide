import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { clampHeight, clampSpan, GRID_COLUMNS, HOME_ROW_PX } from "./home-layout";
import type { WidgetSpan } from "./widget-types";

/**
 * Resizing a panel: two edges, a corner, and a frame that shows the answer
 * before it is committed.
 *
 * This is the second attempt. The first replaced three preset buttons labelled
 * `4 6 12` with a draggable right edge — right idea, wrong feel, for two
 * reasons the owner found in about ten seconds:
 *
 * 1. **The grid moved while you were aiming at it.** The old drag re-laid the
 *    whole page on every pointer move, so the panel under your cursor pushed
 *    its neighbours onto other rows, which changed what you were looking at
 *    mid-gesture. A drag has to leave the thing you are measuring where it is.
 *    So nothing reflows until you let go: what moves is a frame, exactly the
 *    way the agent dock's own splitter shows where it is going to land.
 * 2. **One axis is half a resize.** An edge you can only push sideways is a
 *    width control wearing a resize costume. The corner does both at once,
 *    which is what "resize" has meant in every window manager since 1984.
 */

/** The rectangle the drag is currently asking for, in viewport coordinates. */
export interface ResizeFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What a commit changes. An omitted axis is one the grip does not touch. */
export interface WidgetSize {
  span?: WidgetSpan;
  height?: number | null;
}

/** Which way a grip is allowed to move. */
type Axis = "x" | "y" | "both";

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

const CURSOR: Record<Axis, string> = {
  x: "col-resize",
  y: "row-resize",
  both: "nwse-resize",
};

/**
 * The grips themselves — hairlines, not handles.
 *
 * Two pixels of grip and eight of target, so a panel can wear all three at once
 * without the page turning into a control surface. They live on the *cell*,
 * which is the stretched grid item, so a grip always sits on a rule you can
 * see: the panel's own bottom and right hairlines.
 *
 * The width grips are `xl`-only. Below that the 12-column grid collapses and a
 * width is a setting with no visible effect, but a height is plain pixels and
 * means the same thing at every size — so the bottom grip is always there.
 */
export function WidgetResizeGrips({
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

  // A drag that ends outside the grip still has to end. Listening on the window
  // rather than relying on `setPointerCapture` means the release is caught
  // wherever the cursor happens to be, and a pointer id the browser will not
  // let us capture cannot strand the panel mid-resize.
  useEffect(() => () => release.current?.(), []);

  /** The cell being resized: every grip is a direct child of it. */
  const cellOf = (grip: HTMLElement) => grip.parentElement;

  const measure = (grip: HTMLElement): Origin | null => {
    const cell = cellOf(grip);
    const grid = grip.closest("[data-widget-grid]");
    if (!cell || !grid) return null;
    const rect = cell.getBoundingClientRect();
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

  const targetOf = (event: { clientX: number; clientY: number }, axis: Axis, start: Origin) => ({
    span: axis === "y" ? start.span : clampSpan((event.clientX - start.left) / start.column),
    rows: axis === "x" ? start.rows : clampHeight((event.clientY - start.top) / HOME_ROW_PX),
  });

  const frameFor = (axis: Axis, start: Origin, target: { span: WidgetSpan; rows: number }) => ({
    left: start.left,
    top: start.top,
    // An axis the grip does not touch draws the panel as it actually is, not as
    // the stored numbers describe it — a fit-to-content panel has no row count
    // to draw, and a frame that disagreed with the panel under it would be
    // reporting a resize nobody asked for.
    width: axis === "y" ? start.width : target.span * start.column,
    height: axis === "x" ? start.height : target.rows * HOME_ROW_PX,
  });

  const begin = (axis: Axis) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = measure(event.currentTarget);
    if (!start) return;
    event.preventDefault();

    // The frame is up before the first move: the gesture says what it will do
    // from the moment it starts, and a press that turns out to be a misclick
    // still showed you the panel it was about to change.
    //
    // Drawn at the panel's true rect rather than at the nearest snap, so
    // grabbing an edge moves nothing. A panel fitting its content is rarely an
    // exact number of row units, and a frame that jumped 8px on mousedown would
    // read as the resize having already happened.
    onFrame({ left: start.left, top: start.top, width: start.width, height: start.height });
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = CURSOR[axis];

    const move = (moved: PointerEvent) => onFrame(frameFor(axis, start, targetOf(moved, axis, start)));
    const end = (ended: PointerEvent) => {
      release.current?.();
      release.current = null;
      onFrame(null);
      const target = targetOf(ended, axis, start);
      // Writing preferences on every pointermove would put a `localStorage`
      // write behind every frame of the drag; only the result is saved, and
      // only the axes this grip actually moved.
      const size: WidgetSize = {};
      if (axis !== "y" && target.span !== start.span) size.span = target.span;
      if (axis !== "x" && target.rows !== height) size.height = target.rows;
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
   * Arrow keys do the same job a step at a time. A resize that only answers to
   * a mouse is a control half the users of this page cannot reach, and the
   * steps are the same units the drag snaps to, so the two agree exactly.
   */
  const keys = (axis: Axis) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const horizontal = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const vertical = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (axis !== "y" && horizontal) {
      event.preventDefault();
      onSize({ span: clampSpan(span + horizontal) });
      return;
    }
    if (axis !== "x" && vertical) {
      event.preventDefault();
      const start = measure(event.currentTarget);
      if (start) onSize({ height: clampHeight(start.rows + vertical) });
    }
  };

  /** Double-click gives a height back to the content, the way the dock does. */
  const clearHeight = () => onSize({ height: null });

  const width = t("home.edit.width", { name: title, span, total: GRID_COLUMNS });
  const tall = t("home.edit.height", { name: title });
  const size = t("home.edit.size", { name: title });

  return (
    <>
      <button
        aria-label={width}
        className={cn(GRIP, "inset-y-0 right-0 hidden w-2 cursor-col-resize xl:flex")}
        onKeyDown={keys("x")}
        onPointerDown={begin("x")}
        title={width}
        type="button"
      >
        <span aria-hidden className={cn(BAR, "h-5 w-0.5")} />
      </button>
      <button
        aria-label={tall}
        className={cn(GRIP, "inset-x-0 bottom-0 flex h-2 cursor-row-resize")}
        onDoubleClick={clearHeight}
        onKeyDown={keys("y")}
        onPointerDown={begin("y")}
        title={tall}
        type="button"
      >
        <span aria-hidden className={cn(BAR, "h-0.5 w-5")} />
      </button>
      <button
        aria-label={size}
        /*
          Last, and on top: the corner overlaps both edges, and the gesture
          people reach for first has to win the two pixels they share.
        */
        className={cn(GRIP, "bottom-0 right-0 z-20 hidden size-3 cursor-nwse-resize xl:flex")}
        onDoubleClick={clearHeight}
        onKeyDown={keys("both")}
        onPointerDown={begin("both")}
        title={size}
        type="button"
      >
        <span
          aria-hidden
          className="size-1.5 translate-x-px translate-y-px rounded-[1px] border-b border-r border-border transition-colors group-hover/widget:border-muted-foreground/60"
        />
      </button>
    </>
  );
}

const GRIP =
  "absolute z-10 touch-none items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

const BAR = "rounded-full bg-border transition-colors group-hover/widget:bg-muted-foreground/50";

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
