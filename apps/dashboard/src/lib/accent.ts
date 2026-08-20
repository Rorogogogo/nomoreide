/**
 * Accent theming — lets a user recolor the workbench's primary/accent surfaces
 * (active nav pill, primary buttons, focus rings, accent chips) globally and
 * per-project. Everything keys off five HSL CSS variables, so we apply a choice
 * by writing an override `<style>` element rather than touching components.
 *
 * A choice is either a preset id (see ACCENT_PRESETS) or `custom:<hue>` where
 * hue is 0–359. "classic" reproduces the shipped neutral-primary + emerald look
 * so the default changes nothing.
 */

/** The five tokens each accent drives, as raw `H S% L%` strings (no `hsl()`). */
interface AccentTokens {
  primary: string;
  primaryForeground: string;
  accent: string;
  accentForeground: string;
  ring: string;
}

interface AccentTheme {
  light: AccentTokens;
  dark: AccentTokens;
}

export interface AccentPreset {
  id: string;
  /** i18n key for the human label. */
  labelKey: string;
  /** Swatch color shown in the picker (a plain CSS color). */
  swatch: string;
  theme: AccentTheme;
}

// --- HSL → readable foreground -------------------------------------------------

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100;
  const lum = l / 100;
  const c = (1 - Math.abs(2 * lum - 1)) * sat;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = lum - c / 2;
  return [r + m, g + m, b + m];
}

function relativeLuminance(h: number, s: number, l: number): number {
  const [r, g, b] = hslToRgb(h, s, l).map((v) => {
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Pick black or white text for a colored surface by WCAG contrast. */
function readableForeground(h: number, s: number, l: number): string {
  const bg = relativeLuminance(h, s, l);
  const whiteContrast = 1.05 / (bg + 0.05);
  const blackContrast = (bg + 0.05) / 0.05;
  return whiteContrast >= blackContrast ? "0 0% 100%" : "0 0% 12%";
}

// --- Hue → cohesive, readable token set ---------------------------------------

/**
 * Derive a full accent set from a single hue, tuned per mode: mid-lightness in
 * light mode, lighter in dark mode, with the foreground auto-chosen for contrast
 * (so amber gets dark text, indigo gets white — no per-hue hand-tuning needed).
 */
function tokensFromHue(hue: number, saturation = 62): AccentTheme {
  const h = ((hue % 360) + 360) % 360;
  const s = saturation;
  return {
    light: {
      primary: `${h} ${s}% 43%`,
      primaryForeground: readableForeground(h, s, 43),
      accent: `${h} ${s}% 41%`,
      accentForeground: readableForeground(h, s, 41),
      ring: `${h} ${s}% 45%`,
    },
    dark: {
      primary: `${h} ${s}% 60%`,
      primaryForeground: readableForeground(h, s, 60),
      accent: `${h} ${s}% 58%`,
      accentForeground: readableForeground(h, s, 58),
      ring: `${h} ${s}% 58%`,
    },
  };
}

// The shipped look: neutral primary, emerald accent. Default so nothing changes.
const CLASSIC: AccentTheme = {
  light: {
    primary: "24 9% 10%",
    primaryForeground: "0 0% 98%",
    accent: "170 34% 39%",
    accentForeground: "0 0% 100%",
    ring: "170 34% 39%",
  },
  dark: {
    primary: "0 0% 95%",
    primaryForeground: "24 10% 10%",
    accent: "170 34% 45%",
    accentForeground: "24 10% 10%",
    ring: "170 34% 45%",
  },
};

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: "classic", labelKey: "settingsHub.accent.classic", swatch: "hsl(24 9% 20%)", theme: CLASSIC },
  { id: "emerald", labelKey: "settingsHub.accent.emerald", swatch: "hsl(160 62% 43%)", theme: tokensFromHue(160) },
  { id: "ocean", labelKey: "settingsHub.accent.ocean", swatch: "hsl(205 62% 43%)", theme: tokensFromHue(205) },
  { id: "indigo", labelKey: "settingsHub.accent.indigo", swatch: "hsl(245 62% 47%)", theme: tokensFromHue(245, 58) },
  { id: "violet", labelKey: "settingsHub.accent.violet", swatch: "hsl(272 62% 47%)", theme: tokensFromHue(272) },
  { id: "rose", labelKey: "settingsHub.accent.rose", swatch: "hsl(340 62% 47%)", theme: tokensFromHue(340) },
  { id: "amber", labelKey: "settingsHub.accent.amber", swatch: "hsl(35 80% 50%)", theme: tokensFromHue(35, 80) },
];

const PRESET_BY_ID = new Map(ACCENT_PRESETS.map((preset) => [preset.id, preset]));

/** A saved accent value: a preset id, or `custom:<hue>`. */
export type AccentChoice = string;
export const DEFAULT_ACCENT: AccentChoice = "classic";

const CUSTOM_RE = /^custom:(\d{1,3})$/;

export function isValidAccent(value: unknown): value is AccentChoice {
  if (typeof value !== "string") return false;
  if (PRESET_BY_ID.has(value)) return true;
  const match = CUSTOM_RE.exec(value);
  return match ? Number(match[1]) >= 0 && Number(match[1]) <= 359 : false;
}

/** Extract the hue from a `custom:<hue>` choice, or null for presets. */
export function customHue(value: AccentChoice): number | null {
  const match = CUSTOM_RE.exec(value);
  return match ? Number(match[1]) : null;
}

export function accentSwatch(value: AccentChoice): string {
  const hue = customHue(value);
  if (hue !== null) return `hsl(${hue} 62% 47%)`;
  return PRESET_BY_ID.get(value)?.swatch ?? "hsl(24 9% 20%)";
}

function themeFor(value: AccentChoice): AccentTheme {
  const hue = customHue(value);
  if (hue !== null) return tokensFromHue(hue);
  return (PRESET_BY_ID.get(value) ?? PRESET_BY_ID.get("classic"))!.theme;
}

// --- DOM application ----------------------------------------------------------

const STYLE_ELEMENT_ID = "nomoreide-accent";

function tokenBlock(tokens: AccentTokens): string {
  return (
    `--primary:${tokens.primary};` +
    `--primary-foreground:${tokens.primaryForeground};` +
    `--accent:${tokens.accent};` +
    `--accent-foreground:${tokens.accentForeground};` +
    `--ring:${tokens.ring};`
  );
}

/** Write (or update) the accent override style element for the given choice. */
export function applyAccent(value: AccentChoice): void {
  if (typeof document === "undefined") return;
  const theme = themeFor(isValidAccent(value) ? value : DEFAULT_ACCENT);
  let style = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    // Appended last so it overrides the base tokens in styles.css.
    document.head.appendChild(style);
  }
  style.textContent = `:root{${tokenBlock(theme.light)}}\n.dark{${tokenBlock(theme.dark)}}`;
}

/**
 * Resolve which accent is in effect: a per-project override when the active repo
 * has one, otherwise the global choice.
 */
export function effectiveAccent(
  globalAccent: AccentChoice,
  projectAccents: Record<string, AccentChoice>,
  activeProjectPath: string | null,
): AccentChoice {
  if (activeProjectPath && isValidAccent(projectAccents[activeProjectPath])) {
    return projectAccents[activeProjectPath];
  }
  return isValidAccent(globalAccent) ? globalAccent : DEFAULT_ACCENT;
}
