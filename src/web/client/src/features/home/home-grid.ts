/**
 * Home as a grid of rectangles, and the one function that resolves them.
 *
 * The page used to be **rows of panels**: you authored what sat beside what, and
 * only `y` was computed. That model has a floor at every row boundary, and two
 * things a user reasonably expects turn out to be unsayable inside it — dropping
 * a panel into the empty space left beside a tall one, and dragging a panel down
 * *through* a row so the panels there make room beside it. Neither is a bug in
 * the packer; a row simply has nowhere to put the answer.
 *
 * So a panel is now a rectangle — `x`, `y`, `w`, `h` — on a 12-column grid whose
 * vertical unit is `HOME_ROW_PX`. Everything on the page is an integer number of
 * columns and rows, which is what makes "is this space free" a question with an
 * exact answer instead of a pixel comparison with a tolerance.
 */

/** The grid a width is measured in, and the narrowest panel worth having. */
export const GRID_COLUMNS = 12;
export const MIN_SPAN = 3;

/**
 * The vertical ruler.
 *
 * Columns are a fraction of the window and so need no unit; rows cannot be —
 * there is no page height to divide, because Home scrolls. So a height is a
 * count of fixed 32px units, which is what makes two panels dragged to "4"
 * actually line up.
 *
 * Now that a panel is a rectangle rather than a member of a row, this unit does
 * more than align two panels: it is the grid every position is expressed in, so
 * "is that space free" has an exact answer.
 */
export const HOME_ROW_PX = 32;
export const MIN_HEIGHT = 2;
/**
 * Tall enough to reach down past the panels beside it, which is the whole point
 * of a height that is no longer trapped inside a row. Twelve rows could not
 * clear a neighbour and a half; twenty-four can.
 */
export const MAX_HEIGHT = 24;

/** Where a panel sits and how big it is, in whole columns and rows. */
export interface HomeTile {
  /** Leftmost column, 0-based. */
  x: number;
  /** Top, in row units. */
  y: number;
  /** Width in columns. */
  w: number;
  /**
   * Height in rows, or `null` for a panel as tall as what it holds.
   *
   * `null` is still the default and still means what it always did: how tall a
   * summary needs to be is a fact about what it is summarising, not a layout
   * decision anyone should have to make up front.
   */
  h: number | null;
}

/** A resolved rectangle — every field a number, nothing left to measure. */
export interface TilePlacement {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * How tall a measured panel is, in rows.
 *
 * Rounded *up*, because a row is the unit the whole page is aligned to and half
 * a row of content still needs a row to sit in — rounding down would clip the
 * last line of every panel whose content does not divide by 32.
 */
export function rowsForPx(px: number): number {
  if (!Number.isFinite(px) || px <= 0) return MIN_HEIGHT;
  return Math.max(MIN_HEIGHT, Math.ceil(px / HOME_ROW_PX));
}

/** Any column a drag can produce, pulled back into the grid. */
export function clampX(x: number, w: number, columns: number): number {
  const width = Math.min(Math.max(MIN_SPAN, Math.round(w)), columns);
  return Math.min(Math.max(0, Math.round(x)), columns - width);
}

export function clampW(w: number, columns: number): number {
  return Math.min(Math.max(MIN_SPAN, Math.round(w)), columns);
}

export function clampH(h: number): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(h)));
}

/**
 * The free stretches of a band of rows, as `[start, end)` column pairs.
 *
 * A band rather than a single row because a panel occupies all the rows it is
 * tall: somewhere that is free on its first row and blocked on its third is not
 * somewhere it can go, and checking only the first row is how two panels end up
 * drawn on top of each other.
 */
function freeRuns(taken: boolean[][], y: number, h: number, columns: number): [number, number][] {
  const runs: [number, number][] = [];
  let start: number | null = null;
  for (let x = 0; x <= columns; x += 1) {
    let free = x < columns;
    for (let row = y; free && row < y + h; row += 1) {
      if (taken[row]?.[x]) free = false;
    }
    if (free && start === null) start = x;
    if (!free && start !== null) {
      runs.push([start, x]);
      start = null;
    }
  }
  return runs;
}

/**
 * Resolve stored rectangles into ones that do not overlap.
 *
 * Panels are taken in reading order — down the page, then across — and each one
 * flows into the first place it fits, scanning from the top. That single rule is
 * what gives the page both things rows could not:
 *
 * - **Holes close themselves.** A panel whose turn comes up finds the gap beside
 *   a tall neighbour before it finds the space below it, so the empty band left
 *   by a short panel is filled by whatever comes next rather than being dead
 *   page. It is also what makes "drop it there" mean something: a drop sets the
 *   panel's `y`, which moves it in the reading order, and the flow puts it in
 *   the gap it was aimed at.
 * - **A panel squeezes rather than wrapping, while it still can.** If the run
 *   beside a tall panel is narrower than the panel wants but no narrower than
 *   `MIN_SPAN`, it takes the run and keeps its place on the line instead of
 *   dropping below — which is what makes growing one panel push the others
 *   *aside* rather than merely down.
 *
 * The narrowing is a fact about this layout, never about the panel: `w` is left
 * exactly as stored, so a panel squeezed to eight columns beside a tall
 * neighbour is twelve again the moment that neighbour shrinks. What the user set
 * is what they get back.
 */
export function packTiles(
  entries: { id: string; tile: HomeTile; measuredRows: number }[],
  columns: number,
): TilePlacement[] {
  const lanes = Math.max(1, Math.min(GRID_COLUMNS, Math.floor(columns)));
  const ordered = [...entries].sort((a, b) => a.tile.y - b.tile.y || a.tile.x - b.tile.x);
  const taken: boolean[][] = [];
  const placements: TilePlacement[] = [];

  const rowAt = (row: number): boolean[] => {
    let line = taken[row];
    if (!line) {
      line = new Array<boolean>(lanes).fill(false);
      taken[row] = line;
    }
    return line;
  };

  for (const entry of ordered) {
    const want = Math.min(clampW(entry.tile.w, GRID_COLUMNS), lanes);
    const h = entry.tile.h === null ? entry.measuredRows : clampH(entry.tile.h);
    const preferred = Math.min(Math.max(0, entry.tile.x), Math.max(0, lanes - want));
    /*
      Half its width, and no narrower.

      Squeezing has to have a floor or it stops being squeezing: with none, a
      full-width panel will fold itself down to three columns to slip into any
      crack it passes on the way, and a page rearranges itself into confetti the
      first time one panel grows. Half is the point where the panel is still
      recognisably the thing the user sized — it gives up a lot to stay on the
      line beside a tall neighbour, and drops below rather than becoming a
      sliver of itself in a gap it was never meant for.
    */
    const narrowest = Math.min(want, Math.max(MIN_SPAN, Math.ceil(want / 2)));

    // From the top every time — the stored `y` has already had its say, in the
    // order this loop runs in. Scanning from it instead would leave a panel
    // stranded below a gap it now fits in.
    let y = 0;
    let placed: TilePlacement | null = null;
    while (!placed) {
      for (let row = y; row < y + h; row += 1) rowAt(row);
      const runs = freeRuns(taken, y, h, lanes);
      // The run nearest where the panel wants to be, and wide enough to hold a
      // panel at all. Distance is measured to the run itself, so a panel whose
      // column is occupied slides to the closest free stretch rather than
      // falling to the bottom of the page.
      let best: [number, number] | null = null;
      let bestGap = Number.POSITIVE_INFINITY;
      for (const run of runs) {
        if (run[1] - run[0] < narrowest) continue;
        const gap =
          preferred < run[0] ? run[0] - preferred : preferred > run[1] ? preferred - run[1] : 0;
        if (gap < bestGap) {
          best = run;
          bestGap = gap;
        }
      }
      if (best) {
        const w = Math.min(want, best[1] - best[0]);
        let x = Math.min(Math.max(preferred, best[0]), best[1] - w);
        /*
          Never leave a strip too narrow to hold a panel.

          A rectangle can sit anywhere, which means it can also sit two columns
          in from the edge and strand those two columns for the height of the
          page — nothing is allowed to be narrower than `MIN_SPAN`, so nothing
          can ever fill them. That is the dead space the row model made
          impossible by construction, and the one thing worth keeping from it.
          Snapping to whichever side of the run is too close means every gap
          left behind is either nothing at all or wide enough to be used.
        */
        if (x - best[0] < MIN_SPAN) x = best[0];
        else if (best[1] - (x + w) < MIN_SPAN) x = best[1] - w;
        placed = { id: entry.id, x, y, w, h };
      } else {
        y += 1;
      }
    }

    for (let row = placed.y; row < placed.y + placed.h; row += 1) {
      const line = rowAt(row);
      for (let x = placed.x; x < placed.x + placed.w; x += 1) line[x] = true;
    }
    placements.push(placed);
  }

  return placements;
}

/** How many rows tall the page is — the lowest edge any panel reaches. */
export function gridRows(placements: TilePlacement[]): number {
  return placements.reduce((deepest, place) => Math.max(deepest, place.y + place.h), 0);
}
