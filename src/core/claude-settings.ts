import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Read/write a single setting in the user-global `~/.claude/settings.json`.
 * Keep this narrow — we only touch the keys the UI exposes, and preserve the
 * rest of the file verbatim so users who hand-edit it don't lose data.
 */

export interface ClaudeAttribution {
  /** Trailer Claude Code appends to commits (empty = no trailer). */
  commit?: string;
  /** Trailer Claude Code appends to PR bodies (empty = no trailer). */
  pr?: string;
}

interface SettingsShape {
  attribution?: ClaudeAttribution;
  [key: string]: unknown;
}

function settingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

async function readSettings(): Promise<SettingsShape> {
  try {
    const raw = await readFile(settingsPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as SettingsShape) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeSettings(settings: SettingsShape): Promise<void> {
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Claude Code defaults to including the co-author trailer, so a missing file
 * or missing `attribution` key reads as "on". Only an explicit
 * `{ commit: "", pr: "" }` (or both blank) counts as opted-out.
 */
export async function getCoAuthorWithClaude(): Promise<boolean> {
  const { attribution } = await readSettings();
  if (!attribution) return true;
  const commit = attribution.commit ?? "";
  const pr = attribution.pr ?? "";
  return !(commit === "" && pr === "");
}

export async function setCoAuthorWithClaude(enabled: boolean): Promise<boolean> {
  const settings = await readSettings();
  if (enabled) {
    delete settings.attribution;
  } else {
    settings.attribution = { commit: "", pr: "" };
  }
  await writeSettings(settings);
  return enabled;
}
