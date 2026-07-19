/**
 * Agent settings files (ROR-65-ish): guarded read/write access to each coding
 * agent's *settings* file — distinct from the MCP configs the agent-env
 * readers own. Every write validates the content parses (JSON or TOML),
 * backs up the existing file to a timestamped `.bak.*` sibling, and writes
 * atomically, reusing the agent-env-writers helpers. Human-only surface:
 * deliberately not exposed as an MCP tool (same boundary as DbWrite).
 */
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { atomicWrite, backupFile } from "./agent-env-writers.js";
import type { AgentName } from "./agent-env/index.js";

export interface AgentSettingsOptions {
  /** Injectable for tmpdir tests, like the agent-env readers. */
  homeDir?: string;
}

export interface AgentSettings {
  agent: AgentName;
  path: string;
  exists: boolean;
  format: "json" | "toml";
  /** Raw file content ("" when the file doesn't exist yet). */
  content: string;
  /** Currently configured model, when the file declares one. */
  model?: string;
  /** Whether the curated model switch understands this agent's file. */
  modelEditable: boolean;
}

function settingsPath(agent: AgentName, homeDir: string): string {
  switch (agent) {
    case "claude":
      return path.join(homeDir, ".claude", "settings.json");
    case "codex":
      return path.join(homeDir, ".codex", "config.toml");
    case "antigravity":
      return path.join(homeDir, ".gemini", "settings.json");
  }
}

function settingsFormat(agent: AgentName): "json" | "toml" {
  return agent === "codex" ? "toml" : "json";
}

/** Parse-or-throw with a user-facing message; returns the parsed document. */
function assertParses(content: string, format: "json" | "toml"): Record<string, unknown> {
  try {
    const parsed = format === "json" ? JSON.parse(content) : parseToml(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("top-level value must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Not valid ${format.toUpperCase()}: ${detail}`);
  }
}

export async function readAgentSettings(
  agent: AgentName,
  options: AgentSettingsOptions = {},
): Promise<AgentSettings> {
  const home = options.homeDir ?? homedir();
  const filePath = settingsPath(agent, home);
  const format = settingsFormat(agent);

  let content = "";
  let exists = true;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    exists = false;
  }

  let model: string | undefined;
  if (exists && content.trim()) {
    try {
      const parsed = assertParses(content, format);
      if (typeof parsed.model === "string") model = parsed.model;
    } catch {
      // Unparseable file: still return the raw content so the user can fix it.
    }
  }

  return {
    agent,
    path: filePath,
    exists,
    format,
    content,
    model,
    // Antigravity's settings.json has no documented model key yet.
    modelEditable: agent !== "antigravity",
  };
}

/** Validate, back up, and atomically write the full settings file. */
export async function writeAgentSettings(
  agent: AgentName,
  content: string,
  options: AgentSettingsOptions = {},
): Promise<AgentSettings & { backup: string | null }> {
  const home = options.homeDir ?? homedir();
  const filePath = settingsPath(agent, home);
  assertParses(content, settingsFormat(agent));

  await mkdir(path.dirname(filePath), { recursive: true });
  const backup = await backupFile(filePath);
  await atomicWrite(filePath, content.endsWith("\n") ? content : `${content}\n`);
  return { ...(await readAgentSettings(agent, options)), backup };
}

/**
 * Curated model switch. JSON files get a parse → set → re-stringify;
 * Codex's TOML gets a conservative line edit (replace the root `model = ...`
 * line, or insert one at the top, before any `[section]`) so comments and
 * formatting elsewhere in the file survive.
 */
export async function setAgentModel(
  agent: AgentName,
  model: string,
  options: AgentSettingsOptions = {},
): Promise<AgentSettings & { backup: string | null }> {
  const trimmed = model.trim();
  const current = await readAgentSettings(agent, options);
  if (!current.modelEditable) {
    throw new Error(`Model switching isn't supported for "${agent}".`);
  }

  let next: string;
  if (current.format === "json") {
    const parsed = current.content.trim()
      ? assertParses(current.content, "json")
      : {};
    if (trimmed) parsed.model = trimmed;
    else delete parsed.model;
    next = JSON.stringify(parsed, null, 2) + "\n";
  } else {
    const line = `model = ${JSON.stringify(trimmed)}`;
    // Only edit the root table — `model =` under a `[section]` is a different key.
    const sectionStart = current.content.search(/^\s*\[/m);
    const root = sectionStart === -1 ? current.content : current.content.slice(0, sectionStart);
    const rest = sectionStart === -1 ? "" : current.content.slice(sectionStart);
    if (/^\s*model\s*=.*$/m.test(root)) {
      const nextRoot = trimmed
        ? root.replace(/^\s*model\s*=.*$/m, line)
        : root.replace(/^\s*model\s*=.*\n?/m, "");
      next = nextRoot + rest;
    } else if (trimmed) {
      next = `${line}\n${current.content}`;
    } else {
      next = current.content;
    }
  }

  return writeAgentSettings(agent, next, options);
}
