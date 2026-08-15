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
const MAX_HOME_HEIGHT = 12;

function isInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export interface HomeLayout {
  /**
   * The rows of the page, each holding widget ids left to right.
   *
   * Rows are stored rather than derived, and that is the whole difference
   * between v3 and v4. A flowing list wraps wherever the next widget stops
   * fitting, which leaves the tail of a row empty whenever the leftover is
   * narrower than the next widget wants — and a gap is not something anyone
   * chooses. With rows named, a row's widths always add up to the grid, so
   * there is nowhere for a gap to appear, and "put this one there" has a place
   * to mean. Ids the registry no longer knows are dropped on read.
   */
  rows: string[][];
  /**
   * Per-widget width, in columns, keyed by widget id.
   *
   * Within a row these are shares that sum to the grid, kept that way by every
   * edit and re-fitted on read if a stored layout disagrees.
   */
  spans: Record<string, number>;
  /**
   * Per-widget height override, in row units of `HOME_ROW_PX`.
   *
   * Optional, and absent means something different from every other override
   * here: not "use the declared one" but "no height at all" — the panel is as
   * tall as what it holds, which is how Home behaved before heights existed and
   * is still the right default for a summary. Only a widget someone has dragged
   * vertically gets an entry, so a stored layout from before this field simply
   * keeps fitting its content.
   */
  heights?: Record<string, number>;
}

export interface UiPreferences {
  version: 4;
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
    version: 4,
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
  const input = value as { rows?: unknown; widgets?: unknown; spans?: unknown; heights?: unknown };
  const spans = looseSizes(input.spans, MIN_HOME_SPAN, MAX_HOME_SPAN);
  const stored = Array.isArray(input.rows)
    ? input.rows
    : // A v3 layout is one long list. Packing it into rows here rather than at
      // render time is what makes the migration a one-off: the user's order and
      // widths survive, and from the next edit on the rows are theirs.
      Array.isArray(input.widgets)
      ? packIntoRows(input.widgets, spans)
      : null;
  if (!stored) return null;

  const seen = new Set<string>();
  const rows: string[][] = [];
  for (const row of stored) {
    if (!Array.isArray(row)) continue;
    const ids: string[] = [];
    for (const id of row) {
      // A duplicate id would mount the same widget twice under one React key.
      if (typeof id === "string" && id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    if (ids.length) rows.push(ids);
  }

  return {
    rows,
    spans: sizeOverrides(spans, seen),
    heights: sizeOverrides(looseSizes(input.heights, MIN_HOME_HEIGHT, MAX_HOME_HEIGHT), seen),
  };
}

/**
 * Pack a v3 flat list into rows the way the old flow drew it.
 *
 * The greedy fill this repeats *is* what CSS grid was doing with the same
 * widths, so the first render after the migration looks like the last one
 * before it — minus the gap at the end of a short row, which `fitRow` closes on
 * read and which is the reason rows exist now.
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

/** Every well-formed `id -> size` entry, before it is known which ids exist. */
function looseSizes(value: unknown, min: number, max: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [id, size] of Object.entries(value as Record<string, unknown>)) {
    if (isInRange(size, min, max)) out[id] = size as number;
  }
  return out;
}

/** The same map with every entry for a widget the layout does not show dropped. */
function sizeOverrides(sizes: Record<string, number>, shown: Set<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, size] of Object.entries(sizes)) {
    if (shown.has(id)) out[id] = size;
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
  // Accept v1 (pre-accent), v2 (pre-Home-layout), v3 (Home as a flat list)
  // and v4; older versions are migrated by defaulting the fields they predate,
  // and a v3 Home layout is packed into rows by `sanitizeHomeLayout`.
  if (
    ![1, 2, 3, 4].includes(Number(input.version)) ||
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
    version: 4,
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
