import type { Language } from "@/lib/language";
import {
  applyAccent,
  DEFAULT_ACCENT,
  isValidAccent,
  type AccentChoice,
} from "@/lib/accent";

export const UI_PREFERENCES_KEY = "nomoreide:ui-preferences";

/**
 * How large a widget asks to be: columns of Home's 12-column grid, and row
 * units of its vertical one.
 *
 * The bounds are restated here rather than imported deliberately: this file is
 * the storage schema and must be able to reject a stored `40` without pulling a
 * React feature module into the preference loader that runs before the app
 * mounts. `features/home/home-layout.ts` holds the same numbers for the drag to
 * clamp against.
 */
const MIN_HOME_SPAN = 3;
const MAX_HOME_SPAN = 12;
const GRID_COLUMNS = MAX_HOME_SPAN;
const MIN_HOME_HEIGHT = 2;
/** Matches `MAX_HEIGHT` in `home-grid.ts`: tall enough to clear a neighbour. */
const MAX_HOME_HEIGHT = 24;

function isInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Where one panel sits on the grid, and how big it is. */
export interface HomeTileRecord {
  /** Leftmost column, 0-based. */
  x: number;
  /** Top, in row units. */
  y: number;
  /** Width in columns. */
  w: number;
  /** Height in rows, or `null` for a panel as tall as what it holds. */
  h: number | null;
}

export interface HomeLayout {
  /**
   * Every panel on the page as a rectangle, keyed by widget id.
   *
   * Rectangles rather than rows, and that is the whole difference between v4
   * and v5. Named rows fixed the gap a flowing list left at the end of a short
   * row, but they also put a floor at every row boundary: the empty band beside
   * a tall panel belonged to no row, so nothing could be dropped into it, and a
   * panel could not be dragged down *through* a row to make the panels there
   * move aside. Both are ordinary things to want and neither was expressible.
   *
   * The stored rectangles are intent, not the final answer — they may overlap,
   * and `packTiles` resolves them into a page with no overlaps and no holes.
   * Ids the registry no longer knows are dropped on read.
   */
  tiles: Record<string, HomeTileRecord>;
}

export interface UiPreferences {
  version: 5;
  theme: "light" | "dark" | "system";
  language: Language;
  density: "comfortable" | "compact";
  codeFontSize: number;
  reducedMotion: boolean;
  sidebarDocked: boolean;
  /**
   * Whether the Extensions nav row shows its second layer.
   *
   * Defaults open, and defaults open for existing installs too: the plugins
   * *are* the destinations now that Deploy is not a row of its own, so a
   * collapsed default would hide every provider behind a disclosure triangle.
   */
  extensionsExpanded: boolean;
  agentDockPlacement: "bottom" | "right";
  projectScope: "all" | "project";
  /** Play a short local chime when an agent task exits. */
  agentCompletionSound: boolean;
  /** Global accent choice (preset id or `custom:<hue>`). */
  accent: AccentChoice;
  /** Per-project accent overrides, keyed by repository path. */
  projectAccents: Record<string, AccentChoice>;
  /**
   * Home's layout — `null` until the user first customises it.
   *
   * `null` is not the same as an empty list, and the difference is the whole
   * reason this is nullable. `null` means "I have never touched this", so Home
   * follows the registry: a widget added in a later release simply appears. An
   * empty array means "I removed everything", which is a choice to honour — the
   * page then shows its empty state and the reset action rather than quietly
   * putting the default back and looking broken.
   */
  home: HomeLayout | null;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function defaultUiPreferences(): UiPreferences {
  return {
    version: 5,
    theme: "system",
    language: "en",
    density: "comfortable",
    codeFontSize: 12,
    reducedMotion: prefersReducedMotion(),
    sidebarDocked: false,
    extensionsExpanded: true,
    agentDockPlacement: "bottom",
    projectScope: "all",
    agentCompletionSound: false,
    accent: DEFAULT_ACCENT,
    projectAccents: {},
    home: null,
  };
}

/** Keep only well-formed `path -> accent` entries; drop anything invalid. */
function sanitizeProjectAccents(value: unknown): Record<string, AccentChoice> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, AccentChoice> = {};
  for (const [path, accent] of Object.entries(value as Record<string, unknown>)) {
    if (path && isValidAccent(accent)) out[path] = accent;
  }
  return out;
}

/**
 * Keep a stored Home layout only if it is well-formed; anything else reads as
 * "never customised".
 *
 * Widget ids are checked for shape, not for existence — this file has no
 * business knowing which widgets are registered, and `resolveHomeLayout` drops
 * ids the registry no longer knows at render time (§8.5). Sizes are checked
 * against the grid's bounds, because a stored span of `40` has no column class
 * and would silently render full-width.
 */
function sanitizeHomeLayout(value: unknown): HomeLayout | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as {
    tiles?: unknown;
    rows?: unknown;
    widgets?: unknown;
    spans?: unknown;
    heights?: unknown;
  };
  if (input.tiles && typeof input.tiles === "object" && !Array.isArray(input.tiles)) {
    return { tiles: readTiles(input.tiles as Record<string, unknown>) };
  }
  const spans = looseSizes(input.spans, MIN_HOME_SPAN, MAX_HOME_SPAN);
  const heights = looseSizes(input.heights, MIN_HOME_HEIGHT, MAX_HOME_HEIGHT);
  const rows = Array.isArray(input.rows)
    ? input.rows
    : Array.isArray(input.widgets)
      ? packIntoRows(input.widgets, spans)
      : null;
  if (!rows) return null;
  return { tiles: rowsToTiles(rows, spans, heights) };
}

/** A stored v5 layout, with every coordinate checked against the grid. */
function readTiles(input: Record<string, unknown>): Record<string, HomeTileRecord> {
  const tiles: Record<string, HomeTileRecord> = {};
  for (const [id, value] of Object.entries(input)) {
    if (!id || !value || typeof value !== "object") continue;
    const tile = value as Partial<HomeTileRecord>;
    const w = isInRange(tile.w, MIN_HOME_SPAN, MAX_HOME_SPAN) ? tile.w : MIN_HOME_SPAN;
    tiles[id] = {
      w,
      // Clamped rather than dropped: a rectangle hanging off the right edge is
      // a layout worth keeping, just not there. `x + w` past the grid has no
      // column class and would silently render full-width.
      x: isInRange(tile.x, 0, GRID_COLUMNS - w) ? tile.x : 0,
      y: isInRange(tile.y, 0, Number.MAX_SAFE_INTEGER) ? tile.y : 0,
      h: isInRange(tile.h, MIN_HOME_HEIGHT, MAX_HOME_HEIGHT) ? tile.h : null,
    };
  }
  return tiles;
}

/**
 * A v3/v4 layout, turned into rectangles that draw the page it drew.
 *
 * Rows become bands down the page in the order they were authored, and each
 * row's widths become the `x` of the panels in it — so the first render after
 * the migration is the last one before it. What the user gains on the next edit
 * is that none of those coordinates are trapped in a row any more.
 *
 * The band a row occupies is its tallest stored height, or the floor for a row
 * where nobody set one. Getting that slightly wrong costs nothing: the packer
 * reads `y` for reading order and then flows everything from the top, so a band
 * that was too generous closes itself on the first render.
 */
function rowsToTiles(
  rows: unknown[],
  spans: Record<string, number>,
  heights: Record<string, number>,
): Record<string, HomeTileRecord> {
  const tiles: Record<string, HomeTileRecord> = {};
  const seen = new Set<string>();
  let y = 0;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    let x = 0;
    let band = MIN_HOME_HEIGHT;
    for (const id of row) {
      // A duplicate id would mount the same widget twice under one React key.
      if (typeof id !== "string" || !id || seen.has(id)) continue;
      seen.add(id);
      const w = Math.min(spans[id] ?? MIN_HOME_SPAN, GRID_COLUMNS - Math.min(x, GRID_COLUMNS - 1));
      const h = heights[id] ?? null;
      tiles[id] = { x: Math.min(x, GRID_COLUMNS - w), y, w, h };
      x += w;
      band = Math.max(band, h ?? MIN_HOME_HEIGHT);
    }
    if (x > 0) y += band;
  }
  return tiles;
}

/**
 * Pack a v3 flat list into the rows the old flow drew, so the v4 migration
 * below has rows to turn into rectangles.
 *
 * The greedy fill this repeats *is* what CSS grid was doing with the same
 * widths, so a v3 layout arrives at v5 drawing the page it always drew.
 */
function packIntoRows(widgets: unknown[], spans: Record<string, number>): string[][] {
  const rows: string[][] = [];
  let used = GRID_COLUMNS;
  for (const id of widgets) {
    if (typeof id !== "string" || !id) continue;
    const want = spans[id] ?? MIN_HOME_SPAN;
    if (used + want > GRID_COLUMNS) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1]?.push(id);
    used += want;
  }
  return rows;
}

function looseSizes(value: unknown, min: number, max: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [id, size] of Object.entries(value as Record<string, unknown>)) {
    if (isInRange(size, min, max)) out[id] = size as number;
  }
  return out;
}


function readLegacyPreferences(): Partial<UiPreferences> {
  if (typeof window === "undefined") return {};
  const theme = safeGetItem("nomoreide-theme-choice");
  const language =
    safeGetItem("nomoreide-language") ?? safeGetItem("nomoreide-language-choice");
  const sidebarDocked = safeGetItem("nomoreide:sidebar-docked");
  const projectScope = safeGetItem("nomoreide:project-scope");
  return {
    ...(theme === "light" || theme === "dark" || theme === "system" ? { theme } : {}),
    ...(language === "en" || language === "zh" ? { language } : {}),
    ...(sidebarDocked === "true" || sidebarDocked === "false"
      ? { sidebarDocked: sidebarDocked === "true" }
      : {}),
    ...(projectScope === "all" || projectScope === "project" ? { projectScope } : {}),
  };
}

function safeGetItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function parseUiPreferences(value: unknown): UiPreferences | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  // Accept v1 (pre-accent), v2 (pre-Home-layout), v3 (Home as a flat list),
  // v4 (Home as named rows) and v5; older versions are migrated by defaulting
  // the fields they predate, and a v3 or v4 Home layout is turned into
  // rectangles by `sanitizeHomeLayout`.
  if (
    ![1, 2, 3, 4, 5].includes(Number(input.version)) ||
    !["light", "dark", "system"].includes(String(input.theme)) ||
    !["en", "zh"].includes(String(input.language)) ||
    !["comfortable", "compact"].includes(String(input.density)) ||
    typeof input.codeFontSize !== "number" ||
    !Number.isInteger(input.codeFontSize) ||
    input.codeFontSize < 10 ||
    input.codeFontSize > 18 ||
    typeof input.reducedMotion !== "boolean" ||
    typeof input.sidebarDocked !== "boolean" ||
    !["all", "project"].includes(String(input.projectScope))
  ) {
    return null;
  }
  return {
    ...(input as unknown as UiPreferences),
    version: 5,
    agentDockPlacement:
      input.agentDockPlacement === "right" ? "right" : "bottom",
    agentCompletionSound: input.agentCompletionSound === true,
    // Absent in preferences stored before the second-layer nav existed, and
    // `undefined` there must read as open rather than as collapsed.
    extensionsExpanded: input.extensionsExpanded !== false,
    accent: isValidAccent(input.accent) ? input.accent : DEFAULT_ACCENT,
    projectAccents: sanitizeProjectAccents(input.projectAccents),
    home: sanitizeHomeLayout(input.home),
  };
}

export function mergeUiPreferences(
  current: UiPreferences,
  patch: Partial<Omit<UiPreferences, "version">>,
): UiPreferences | null {
  return parseUiPreferences({ ...current, ...patch });
}

export function saveUiPreferences(preferences: unknown): boolean {
  const validated = parseUiPreferences(preferences);
  if (!validated) return false;
  try {
    window.localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(validated));
    return true;
  } catch {
    // Storage can be unavailable; the provider still keeps the in-memory value.
    return false;
  }
}

export function loadUiPreferences(): UiPreferences {
  let stored: UiPreferences | null = null;
  try {
    const raw = safeGetItem(UI_PREFERENCES_KEY);
    stored = raw ? parseUiPreferences(JSON.parse(raw)) : null;
  } catch {
    stored = null;
  }
  const preferences = stored ?? { ...defaultUiPreferences(), ...readLegacyPreferences() };
  saveUiPreferences(preferences);
  return preferences;
}

export function resetUiPreferences(): UiPreferences {
  const preferences = defaultUiPreferences();
  saveUiPreferences(preferences);
  return preferences;
}

export function applyUiPreferences(preferences: UiPreferences): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.density = preferences.density;
  root.dataset.reducedMotion = String(preferences.reducedMotion);
  root.style.setProperty("--code-font-size", `${preferences.codeFontSize}px`);
  // Baseline (global) accent so there's no flash before the settings context
  // refines it with any per-project override.
  applyAccent(preferences.accent);
}
