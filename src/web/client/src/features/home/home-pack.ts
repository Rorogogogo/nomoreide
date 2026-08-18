import type { HomeLayout } from "@/features/settings/ui-preferences";
import {
  GRID_COLUMNS,
  HOME_ROW_PX,
  moveWidget,
  resolveHomeLayout,
  setWidgetSize,
  type DropTarget,
  type PlacedRow,
} from "./home-layout";
import type { WidgetDefinition, WidgetSpan } from "./widget-types";

/**
 * Where every panel actually sits — the arithmetic CSS grid was doing until it
 * could not.
 *
 * A grid row is as tall as its tallest cell. That is not a bug in the old
 * layout, it is what a row *is*, and it meant a short panel beside a tall one
 * left dead space underneath that nothing could fill: the next row starts below
 * the tallest member, never below the short one. The only way a panel rises into
 * that space is if the page stops being a grid of rows and every panel is placed
 * by hand — which is what this file does.
 *
 * **The rows survive; only `y` changes.** A row still authors reading order,
 * left-to-right position and width, still fills all twelve columns, and is still
 * where a drop and a splitter resize do their work (`home-layout.ts`). What a row
 * no longer decides is how far down its panels start. That is the smallest
 * possible version of the change: everything the layout model guarantees is
 * guaranteed the same way, and one coordinate moved from CSS into here.
 *
 * The placement rule is a **skyline**: each panel, taken in reading order, drops
 * until it lands on the lowest thing already occupying any column it covers.
 * Bottom edges therefore stop lining up — that raggedness is the feature, and it
 * is why this cannot be expressed as rows.
 *
 * Raggedness worth having is raggedness you can *read* as a decision. Two panels
 * ending seven pixels apart is not one: it is the arithmetic showing through, and
 * it reads as a page that failed to line up rather than as one whose columns are
 * genuinely different lengths. So a near-miss is levelled (`HOME_SNAP_PX`) and
 * everything else is left exactly where the skyline put it.
 *
 * With one exception, and it is the same argument taken to its end. A column's
 * leftover space is only worth keeping because the *next* panel in that column
 * rises into it — that is the entire reason this file exists. When the next
 * panel spans the column instead, nothing can ever rise into it: the space is
 * sealed above by what is already there and below by what just arrived, and a
 * hole is what a page looks like when it has failed to finish. That space is
 * given back to the panels above it, however big it is.
 *
 * Everything here is pure — `(rows, measured heights, column count)` in,
 * rectangles out — so the packing is tested without mounting React, exactly as
 * `home-layout.ts` is. The DOM measuring that feeds it lives in
 * `home-masonry.tsx`, which is the only part that needs a browser.
 */

/**
 * Where the twelve columns stop meaning anything.
 *
 * These are Tailwind's `xl` and `md`, restated as numbers because the placement
 * is now computed rather than expressed in classes. They have to keep matching
 * the breakpoints the rest of the app is built on, so a panel does not change
 * width at a different window size than the sidebar next to it.
 */
export const HOME_WIDE_WIDTH = 1280;
export const HOME_MID_WIDTH = 768;

/**
 * How far a panel will be stretched to meet the line beside it.
 *
 * A gap this small is never something anyone chose. Heights arrive from two
 * different worlds — a dragged one is a whole number of `HOME_ROW_PX` rows, a
 * fitted one is however tall its text came out — and the two agree only by luck,
 * so panels that were meant to end together end a few pixels apart. Levelling
 * that is the whole of this: the *shorter* panel grows to the line, which closes
 * the sliver of dead space at the same time, and nothing below moves because the
 * line it grows to is one its neighbour had already set.
 *
 * Well under half a row, deliberately. A dragged height can only differ from
 * another dragged height by a whole row, so this can never quietly absorb a row
 * the user asked for — and a panel one line of text short of its neighbour
 * (~16px) stays short, because that is a real difference in what it holds.
 */
export const HOME_SNAP_PX = 12;

/**
 * One panel's rectangle: a share of the width, and real pixels down the page.
 *
 * Horizontal in whole columns rather than in pixels or a formatted percentage.
 * Rendering divides them (`panelStyle`) and the drop preview multiplies them
 * back up against the grid's real width, and neither has to parse a CSS string
 * or carry a rounding error the other does not.
 */
export interface PanelPlacement {
  id: string;
  /** Leftmost column, 0-based. */
  column: number;
  /** Width, in columns. */
  span: number;
  /** How many columns there were to divide — the denominator for both. */
  lanes: number;
  /** Pixels from the top of the grid. */
  top: number;
  /** Pixels tall: the stored height, or what the panel measured. */
  height: number;
  /**
   * The height is the user's, not a measurement — so nothing may stretch it.
   *
   * Levelling exists to close the gaps *between* panels nobody sized, where a
   * few pixels of difference is noise rather than a decision. A dragged corner
   * is the opposite: it is the one height on the page someone chose on purpose,
   * and a rule that grew it back to match a taller neighbour made the drag look
   * broken — the body dutifully became 64px while the slot it sits in stayed
   * 257, so the panel on screen never changed and the gesture read as ignored.
   */
  fixed: boolean;
}

export interface PackedHome {
  placements: PanelPlacement[];
  /** How tall the grid has to be to contain them — its `height`, in px. */
  height: number;
}

/**
 * How many columns there are to divide, at a given container width.
 *
 * Below `xl` the twelfths are useless — there is not enough width for a 4-span
 * panel to hold a stat strip and a row list — so the grid collapses to two
 * columns and then to one, which is exactly what the `md:`/`xl:` classes did
 * before. Masonry keeps working the whole way down: with one column it is a
 * plain stack, which is the correct degenerate case rather than a special one.
 */
export function gridColumns(width: number): number {
  if (width >= HOME_WIDE_WIDTH) return GRID_COLUMNS;
  if (width >= HOME_MID_WIDTH) return 2;
  return 1;
}

/**
 * A stored width, in the columns actually available.
 *
 * The thresholds are the old `SPAN_CLASS` map: anything wider than half the grid
 * took both `md` columns, everything else took one. Keeping the same rule means
 * collapsing the window rearranges the page the way it always did.
 */
export function spanFor(span: number, columns: number): number {
  if (columns >= GRID_COLUMNS) return Math.min(span, columns);
  if (columns === 2) return span >= 7 ? 2 : 1;
  return 1;
}

/**
 * Drop every panel as far up as it will go.
 *
 * `measured` holds what each panel's body actually came out as, by id. It is
 * consulted even for a panel with a stored height, because the stored number is
 * a *request* — the height that ends up on screen is the one the skyline has to
 * stack against, and trusting the request over the measurement is how a panel
 * ends up overlapping the one below it by a pixel.
 *
 * Unmeasured panels fall back to their stored height and then to zero, which is
 * only ever the state of the very first pass, before anything has been laid out.
 */
export function packHome(
  rows: PlacedRow[],
  measured: Record<string, number>,
  columns: number,
): PackedHome {
  const lanes = Math.max(1, Math.floor(columns));
  const skyline = new Array<number>(lanes).fill(0);
  // Which panel each column's current depth belongs to — the one that would have
  // to grow for that column to reach further down. A column nothing has been
  // placed in yet belongs to nobody and is never stretched to meet anything.
  const owners = new Array<PanelPlacement | null>(lanes).fill(null);
  const placements: PanelPlacement[] = [];

  for (const row of rows) {
    // The cursor restarts at each row, which is what keeps the authored rows
    // authored: at twelve columns a row's widths sum to the grid, so the cursor
    // lands back at zero exactly when the row ends. Below `xl` a row of four
    // panels no longer fits on one line and wraps within itself — the same thing
    // its own `grid-cols-2` did, and the reason rows never merge into each other
    // on a narrow window.
    let cursor = 0;
    for (const placed of row.widgets) {
      const span = Math.max(1, Math.min(spanFor(placed.span, lanes), lanes));
      if (cursor + span > lanes) cursor = 0;
      const id = placed.widget.id;
      const fixed = placed.height !== null;
      const height = heightOf(placed.height, measured[id]);

      // The skyline: the panel rests on the lowest thing under *any* column it
      // covers, so a wide panel is held up by whichever narrow one beside it ran
      // longest. Taking the max is the whole of masonry.
      let top = 0;
      for (let lane = cursor; lane < cursor + span; lane += 1) {
        top = Math.max(top, skyline[lane] ?? 0);
      }
      // A panel arriving closes the columns it covers: nothing can be placed in
      // them above it ever again, so whatever space is left between them and its
      // top edge is dead. It goes to the panels that are already there — no
      // tolerance, because this is not a near-miss, it is a hole with a lid on
      // it. A hole is what the eye reads as a page that failed to finish, and it
      // takes the top edge off whatever is drawn underneath it.
      levelTo(skyline, owners, cursor, cursor + span, top, Number.POSITIVE_INFINITY);

      const place: PanelPlacement = { id, column: cursor, span, lanes, top, height, fixed };
      for (let lane = cursor; lane < cursor + span; lane += 1) {
        skyline[lane] = top + height;
        owners[lane] = place;
      }
      // And now that it has a bottom edge of its own, against the panel beside
      // it. This is the one that matters most: two panels side by side ending a
      // few pixels apart is the misalignment you actually see, and nothing has
      // to arrive underneath them for it to be visible.
      levelBeside(skyline, owners, place);

      placements.push(place);
      cursor += span;
    }
  }

  // And the page's own bottom edge is the last such line — but only for a
  // near-miss. Nothing is enclosing the space below the last row: it is where
  // the page stops, not a hole, and a panel stretched a hundred pixels into it
  // would be a box mostly full of nothing for no reason. Read the height first —
  // levelling only raises columns *to* it, so it cannot change.
  const height = Math.max(0, ...skyline);
  levelTo(skyline, owners, 0, lanes, height, HOME_SNAP_PX);

  return { placements, height };
}

/**
 * Level a panel and the one immediately beside it, whichever is the shorter.
 *
 * Only the flanking columns — the panel one place to the left and one to the
 * right — because those are the two edges anyone is actually comparing. A pair
 * levelled here stays levelled for whatever lands on them next, which is how one
 * pairwise rule ends up straightening a whole line.
 */
function levelBeside(
  skyline: number[],
  owners: (PanelPlacement | null)[],
  place: PanelPlacement,
): void {
  for (const lane of [place.column - 1, place.column + place.span]) {
    const beside = owners[lane];
    if (!beside) continue;
    const depth = skyline[lane] ?? 0;
    // Whichever of the two stops higher is the one that grows. `raiseTo` decides
    // which that is: it does nothing for a panel already at or past the line.
    raiseTo(skyline, owners, place, depth, HOME_SNAP_PX);
    raiseTo(skyline, owners, beside, place.top + place.height, HOME_SNAP_PX);
  }
}

/**
 * Stretch whatever ends above `line` down onto it, as far as `limit` allows.
 *
 * `HOME_SNAP_PX` is the near-miss: a column further short than that ran out
 * early on purpose, which is the raggedness masonry exists to allow. No limit is
 * for space that has been closed off from above — there, a column ending early
 * is not a difference anyone can see the point of, it is a hole.
 */
function levelTo(
  skyline: number[],
  owners: (PanelPlacement | null)[],
  from: number,
  to: number,
  line: number,
  limit: number,
): void {
  for (let lane = from; lane < to; lane += 1) {
    const place = owners[lane];
    if (place) raiseTo(skyline, owners, place, line, limit);
  }
}

/**
 * The whole of the stretch: one panel, one line, and the two reasons not to.
 *
 * A panel already level with the line, or past it, has nothing to do — which is
 * what lets a caller offer both sides of a pair to this and let it pick. Growing
 * is safe precisely when the panel still owns every column it covers: that is
 * what says nothing has been placed underneath it yet. A panel that has had one
 * of its columns built over cannot grow into the panel now sitting there, so it
 * stays as it is and the sliver stays with it.
 */
function raiseTo(
  skyline: number[],
  owners: (PanelPlacement | null)[],
  place: PanelPlacement,
  line: number,
  limit: number,
): void {
  // A height someone dragged is an answer, not a measurement — see `fixed`.
  // The panel still *holds up* whatever lands under it, because its columns are
  // closed at its own bottom edge either way; what it will not do is grow.
  if (place.fixed) return;
  const gap = line - (place.top + place.height);
  if (gap <= 0 || gap > limit) return;
  if (!ownsSpan(owners, place)) return;
  place.height += gap;
  // Every column it covers, not just the one that asked: the panel got taller,
  // and a column left at the old depth would let the next panel overlap it.
  for (let lane = place.column; lane < place.column + place.span; lane += 1) {
    skyline[lane] = line;
  }
}

function ownsSpan(owners: (PanelPlacement | null)[], place: PanelPlacement): boolean {
  for (let lane = place.column; lane < place.column + place.span; lane += 1) {
    if (owners[lane] !== place) return false;
  }
  return true;
}

/**
 * The rectangle a panel would occupy if it were dropped where it is being
 * aimed — the drop's answer, before the drop.
 *
 * It runs the *actual* move against a copy of the layout and packs the result,
 * so what the drag draws and what the release produces are the same arithmetic
 * rather than two implementations that agree until they don't. This is the same
 * bargain `previewResize` makes for the resize frame, and it is only affordable
 * here because masonry turned placement into a pure function — under CSS grid
 * there was nothing to ask but the browser, and only after committing.
 *
 * One approximation, and it is in the height. `measured` is what the panels are
 * *now*; a panel with no stored height that lands in a narrower slot will wrap
 * more and end up taller than the frame promised. Position and width are exact,
 * which is what the gesture is actually about — re-measuring a panel at a width
 * it does not have yet would mean rendering it twice on every pointermove.
 */
/**
 * Where a panel would sit if it were the width the drag is asking for.
 *
 * A width is not only a width: the columns come out of the neighbours, and which
 * neighbour gives them up decides whether the panel grows to the right or the
 * left. A panel at the end of its row grows *leftwards* — its right edge is
 * already the page's — and one asking for the whole grid starts at the first
 * column wherever it used to be. A frame drawn from the panel's current left
 * edge would be wrong in both cases, and wrong at the one moment it is being
 * read.
 *
 * Heights are nobody's business here, so none are passed: what column a panel
 * lands in is decided by spans and reading order alone.
 */
export function previewResize(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
  span: WidgetSpan,
  columns: number,
): Pick<PanelPlacement, "column" | "span" | "lanes"> | null {
  const sized = setWidgetSize(widgets, layout, id, { span });
  const packed = packHome(resolveHomeLayout(widgets, sized), {}, columns);
  return packed.placements.find((place) => place.id === id) ?? null;
}

export function previewPlacement(
  widgets: WidgetDefinition[],
  layout: HomeLayout | null,
  id: string,
  target: DropTarget,
  measured: Record<string, number>,
  columns: number,
): PanelPlacement | null {
  const moved = moveWidget(widgets, layout, id, target);
  const packed = packHome(resolveHomeLayout(widgets, moved), measured, columns);
  return packed.placements.find((place) => place.id === id) ?? null;
}

/**
 * What a panel is worth to the skyline.
 *
 * A measurement beats a stored height, and zero is never a measurement — an
 * element that has not been laid out yet reports zero, and treating that as a
 * real height would stack the whole page on top of itself.
 *
 * The stored number is a *request*, and what a request got is a fact only the
 * DOM has. Stacking against the request instead would overlap the panel below
 * by whatever the two differ by — which is why `fixed` refuses the *stretch*
 * rather than refusing the measurement: the height a panel was given is honoured
 * by never growing it, not by disbelieving the box on screen.
 */
function heightOf(stored: number | null, measured: number | undefined): number {
  if (measured !== undefined && measured > 0) return measured;
  return stored === null ? 0 : stored * HOME_ROW_PX;
}
