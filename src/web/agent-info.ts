import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AgentMemoryFile {
  path: string;
  name: string;
  size: number;
  preview: string;
}

export interface AgentSkill {
  name: string;
  scope: "user" | "project" | "plugin" | "system";
  path: string;
  description?: string;
}

export interface AgentMcpServer {
  name: string;
  scope: "user" | "project";
  command?: string;
  args?: string[];
  type?: string;
  url?: string;
}

export interface AgentProjectEntry {
  path: string;
  current: boolean;
  lastSessionFirstPrompt?: string;
  lastSessionModified?: string;
  mcpServerCount: number;
}

export interface AgentProfile {
  project: {
    cwd: string;
    instructionFilePath?: string;
    instructionFileName?: string;
    instructionFilePreview?: string;
    claudeMdPath?: string;
    claudeMdPreview?: string;
    memoryDir?: string;
    memoryFiles: AgentMemoryFile[];
  };
  skills: AgentSkill[];
  mcpServers: AgentMcpServer[];
  projects: AgentProjectEntry[];
}

export interface AgentInfo extends AgentProfile {
  detected: {
    name: "claude-code" | "codex" | "gemini" | "unknown";
    label: string;
    signals: string[];
    parentProcess?: string;
  };
  agents: {
    "claude-code": AgentProfile;
    codex: AgentProfile;
  };
}

const PREVIEW_BYTES = 1200;

export async function buildAgentInfo(cwd: string): Promise<AgentInfo> {
  const detected = await detectAgent();
  const home = homedir();
  const codexHome = process.env.CODEX_HOME || join(home, ".codex");

  const [
    claudeProject,
    claudeSkills,
    claudeJson,
    codexProject,
    codexSkills,
    codexConfig,
    codexProjects,
  ] = await Promise.all([
    collectClaudeProjectMemory(cwd, home),
    collectClaudeSkills(home, cwd),
    readClaudeJson(home),
    collectCodexProjectMemory(cwd, codexHome),
    collectCodexSkills(codexHome, cwd),
    readCodexConfig(codexHome),
    collectCodexProjects(codexHome, cwd),
  ]);

  const claudeProfile: AgentProfile = {
    project: claudeProject,
    skills: claudeSkills,
    mcpServers: collectClaudeMcpServers(claudeJson, cwd),
    projects: collectClaudeProjects(claudeJson, cwd),
  };
  const codexProfile: AgentProfile = {
    project: codexProject,
    skills: codexSkills,
    mcpServers: collectCodexMcpServers(codexConfig),
    projects: mergeCodexProjects(codexConfig, codexProjects, cwd),
  };
  const activeProfile = detected.name === "codex" ? codexProfile : claudeProfile;

  return {
    detected,
    ...activeProfile,
    agents: {
      "claude-code": claudeProfile,
      codex: codexProfile,
    },
  };
}

export async function detectAgent(): Promise<AgentInfo["detected"]> {
  const env = process.env;
  const signals: string[] = [];
  let name: AgentInfo["detected"]["name"] = "unknown";
  let label = "Unknown agent";

  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_PROJECT_DIR) {
    name = "claude-code";
    label = "Claude Code";
    if (env.CLAUDECODE === "1") signals.push("CLAUDECODE=1");
    if (env.CLAUDE_CODE_ENTRYPOINT) signals.push(`CLAUDE_CODE_ENTRYPOINT=${env.CLAUDE_CODE_ENTRYPOINT}`);
    if (env.CLAUDE_PROJECT_DIR) signals.push("CLAUDE_PROJECT_DIR set");
  } else if (env.CODEX_HOME || env.CODEX_SANDBOX || env.CODEX_CLI) {
    name = "codex";
    label = "OpenAI Codex CLI";
    if (env.CODEX_HOME) signals.push("CODEX_HOME set");
    if (env.CODEX_SANDBOX) signals.push("CODEX_SANDBOX set");
  } else if (env.GEMINI_API_KEY || env.GEMINI_CLI || env.GOOGLE_GENAI_USE_VERTEXAI) {
    name = "gemini";
    label = "Gemini CLI";
    if (env.GEMINI_CLI) signals.push("GEMINI_CLI set");
  }

  let parentProcess: string | undefined;
  try {
    const ppid = process.ppid;
    if (ppid && ppid > 1) {
      const { stdout } = await execFileAsync("ps", ["-o", "command=", "-p", String(ppid)], {
        timeout: 1000,
      });
      parentProcess = stdout.trim().split("\n")[0]?.slice(0, 240);
      if (parentProcess && name === "unknown") {
        const lower = parentProcess.toLowerCase();
        if (lower.includes("claude")) {
          name = "claude-code";
          label = "Claude Code";
          signals.push(`parent: ${parentProcess}`);
        } else if (lower.includes("codex")) {
          name = "codex";
          label = "OpenAI Codex CLI";
          signals.push(`parent: ${parentProcess}`);
        } else if (lower.includes("gemini")) {
          name = "gemini";
          label = "Gemini CLI";
          signals.push(`parent: ${parentProcess}`);
        }
      }
    }
  } catch {
    // ignore ps failures
  }

  return { name, label, signals, parentProcess };
}

function projectSlug(cwd: string): string {
  // Claude Code encodes project dirs by replacing path separators with "-"
  return cwd.replace(/[/\\]/g, "-").replace(/\s+/g, "-");
}

async function collectClaudeProjectMemory(
  cwd: string,
  home: string,
): Promise<AgentProfile["project"]> {
  const result: AgentProfile["project"] = {
    cwd,
    memoryFiles: [],
  };

  const claudeMdPath = resolve(cwd, "CLAUDE.md");
  const claudeMdContent = await safeReadPreview(claudeMdPath);
  if (claudeMdContent !== undefined) {
    result.claudeMdPath = claudeMdPath;
    result.claudeMdPreview = claudeMdContent;
    result.instructionFilePath = claudeMdPath;
    result.instructionFileName = "CLAUDE.md";
    result.instructionFilePreview = claudeMdContent;
  }

  const slug = projectSlug(cwd);
  const memoryDir = join(home, ".claude", "projects", slug, "memory");
  try {
    const entries = await readdir(memoryDir);
    result.memoryDir = memoryDir;
    const files = await Promise.all(
      entries
        .filter((name) => name.endsWith(".md"))
        .map(async (name) => {
          const filePath = join(memoryDir, name);
          const [s, preview] = await Promise.all([
            stat(filePath).catch(() => null),
            safeReadPreview(filePath),
          ]);
          if (!s || preview === undefined) return null;
          return {
            path: filePath,
            name,
            size: s.size,
            preview,
          } satisfies AgentMemoryFile;
        }),
    );
    result.memoryFiles = files.filter((file): file is AgentMemoryFile => file !== null);
    result.memoryFiles.sort((a, b) => {
      if (a.name === "MEMORY.md") return -1;
      if (b.name === "MEMORY.md") return 1;
      return a.name.localeCompare(b.name);
    });
  } catch {
    // memory dir doesn't exist for this project
  }

  return result;
}

async function collectCodexProjectMemory(
  cwd: string,
  codexHome: string,
): Promise<AgentProfile["project"]> {
  const result: AgentProfile["project"] = {
    cwd,
    memoryFiles: [],
  };

  const agentsMdPath = resolve(cwd, "AGENTS.md");
  const agentsMdContent = await safeReadPreview(agentsMdPath);
  if (agentsMdContent !== undefined) {
    result.instructionFilePath = agentsMdPath;
    result.instructionFileName = "AGENTS.md";
    result.instructionFilePreview = agentsMdContent;
  }

  await readMemoryFiles(join(codexHome, "memories"), result);
  await readMemoryFiles(join(cwd, ".codex", "memories"), result);
  result.memoryFiles.sort((a, b) => a.name.localeCompare(b.name));

  return result;
}

async function readMemoryFiles(dir: string, out: AgentProfile["project"]): Promise<void> {
  try {
    const entries = await readdir(dir);
    out.memoryDir ??= dir;
    const files = await Promise.all(
      entries
        .filter((name) => name.endsWith(".md"))
        .map(async (name) => {
          const filePath = join(dir, name);
          const [s, preview] = await Promise.all([
            stat(filePath).catch(() => null),
            safeReadPreview(filePath),
          ]);
          if (!s || preview === undefined) return null;
          return {
            path: filePath,
            name,
            size: s.size,
            preview,
          } satisfies AgentMemoryFile;
        }),
    );
    out.memoryFiles.push(...files.filter((file): file is AgentMemoryFile => file !== null));
  } catch {
    // memory dir doesn't exist for this agent/project
  }
}

async function collectClaudeSkills(home: string, cwd: string): Promise<AgentSkill[]> {
  const skills: AgentSkill[] = [];
  const userSkills = join(home, ".claude", "skills");
  const projectSkills = join(cwd, ".claude", "skills");
  const pluginsDir = join(home, ".claude", "plugins", "data");

  await Promise.all([
    readSkillsDir(userSkills, "user", skills),
    readSkillsDir(projectSkills, "project", skills),
    readPluginSkills(pluginsDir, skills),
  ]);

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

async function collectCodexSkills(codexHome: string, cwd: string): Promise<AgentSkill[]> {
  const skills: AgentSkill[] = [];

  await Promise.all([
    readSkillsDir(join(codexHome, "skills"), "user", skills, true),
    readSkillsDir(join(codexHome, "skills", ".system"), "system", skills),
    readSkillsDir(join(cwd, ".codex", "skills"), "project", skills),
  ]);

  skills.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
    return a.name.localeCompare(b.name);
  });
  return skills;
}

async function readSkillsDir(
  dir: string,
  scope: AgentSkill["scope"],
  out: AgentSkill[],
  skipDotDirs = false,
): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skipDotDirs && entry.name.startsWith(".")) continue;
      const skillDir = join(dir, entry.name);
      const description = await readSkillDescription(skillDir);
      out.push({ name: entry.name, scope, path: skillDir, description });
    }
  } catch {
    // ignore
  }
}

async function readPluginSkills(pluginsDataDir: string, out: AgentSkill[]): Promise<void> {
  try {
    const entries = await readdir(pluginsDataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillsDir = join(pluginsDataDir, entry.name, "skills");
      try {
        const skillEntries = await readdir(skillsDir, { withFileTypes: true });
        for (const skillEntry of skillEntries) {
          if (!skillEntry.isDirectory()) continue;
          const skillDir = join(skillsDir, skillEntry.name);
          const description = await readSkillDescription(skillDir);
          out.push({
            name: `${entry.name}:${skillEntry.name}`,
            scope: "plugin",
            path: skillDir,
            description,
          });
        }
      } catch {
        // not a skill-bearing plugin
      }
    }
  } catch {
    // ignore
  }
}

async function readSkillDescription(skillDir: string): Promise<string | undefined> {
  const skillFile = join(skillDir, "SKILL.md");
  const content = await safeReadPreview(skillFile, 400);
  if (!content) return undefined;
  const match = content.match(/^description:\s*(.+)$/m);
  if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  return undefined;
}

interface ClaudeJsonShape {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, {
    mcpServers?: Record<string, unknown>;
    lastSessionFirstPrompt?: string;
    lastSessionModified?: string;
  }>;
}

interface CodexConfigShape {
  mcpServers: Record<string, Record<string, unknown>>;
  projects: Record<string, Record<string, unknown>>;
}

async function readClaudeJson(home: string): Promise<ClaudeJsonShape | null> {
  try {
    const raw = await readFile(join(home, ".claude.json"), "utf8");
    return JSON.parse(raw) as ClaudeJsonShape;
  } catch {
    return null;
  }
}

function collectClaudeMcpServers(
  claudeJson: ClaudeJsonShape | null,
  cwd: string,
): AgentMcpServer[] {
  if (!claudeJson) return [];
  const results: AgentMcpServer[] = [];

  for (const [name, raw] of Object.entries(claudeJson.mcpServers ?? {})) {
    results.push(mcpEntry(name, "user", raw));
  }
  const projectEntry = claudeJson.projects?.[cwd];
  for (const [name, raw] of Object.entries(projectEntry?.mcpServers ?? {})) {
    results.push(mcpEntry(name, "project", raw));
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

function mcpEntry(name: string, scope: "user" | "project", raw: unknown): AgentMcpServer {
  const entry: AgentMcpServer = { name, scope };
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    if (typeof value.command === "string") entry.command = value.command;
    if (Array.isArray(value.args)) {
      entry.args = value.args.filter((item): item is string => typeof item === "string");
    }
    if (typeof value.type === "string") entry.type = value.type;
    if (typeof value.url === "string") entry.url = value.url;
  }
  return entry;
}

function collectClaudeProjects(
  claudeJson: ClaudeJsonShape | null,
  cwd: string,
): AgentProjectEntry[] {
  if (!claudeJson?.projects) return [];
  const entries = Object.entries(claudeJson.projects).map(([path, value]) => ({
    path,
    current: path === cwd,
    lastSessionFirstPrompt: value.lastSessionFirstPrompt,
    lastSessionModified: value.lastSessionModified,
    mcpServerCount: Object.keys(value.mcpServers ?? {}).length,
  }));

  entries.sort((a, b) => {
    if (a.current && !b.current) return -1;
    if (!a.current && b.current) return 1;
    const aTime = a.lastSessionModified ? Date.parse(a.lastSessionModified) : 0;
    const bTime = b.lastSessionModified ? Date.parse(b.lastSessionModified) : 0;
    if (aTime !== bTime) return bTime - aTime;
    return basename(a.path).localeCompare(basename(b.path));
  });

  return entries.slice(0, 25);
}

async function readCodexConfig(codexHome: string): Promise<CodexConfigShape> {
  const result: CodexConfigShape = { mcpServers: {}, projects: {} };
  try {
    const raw = await readFile(join(codexHome, "config.toml"), "utf8");
    const sections = parseTomlSections(raw);
    for (const [section, values] of Object.entries(sections)) {
      const parts = splitTomlSection(section);
      if (parts[0] === "mcp_servers" && parts.length === 2) {
        result.mcpServers[parts[1]] = values;
      } else if (parts[0] === "projects" && parts.length === 2) {
        result.projects[parts[1]] = values;
      }
    }
  } catch {
    // Codex config is optional.
  }
  return result;
}

function collectCodexMcpServers(config: CodexConfigShape): AgentMcpServer[] {
  return Object.entries(config.mcpServers)
    .map(([name, raw]) => mcpEntry(name, "user", raw))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function collectCodexProjects(
  codexHome: string,
  cwd: string,
): Promise<AgentProjectEntry[]> {
  const files: string[] = [];
  await collectJsonlFiles(join(codexHome, "sessions"), files);
  const byPath = new Map<string, AgentProjectEntry>();

  for (const file of files) {
    const meta = await readCodexSessionMeta(file);
    if (!meta?.cwd) continue;
    const existing = byPath.get(meta.cwd);
    const nextTime = meta.timestamp ? Date.parse(meta.timestamp) : 0;
    const existingTime = existing?.lastSessionModified
      ? Date.parse(existing.lastSessionModified)
      : 0;
    if (!existing || nextTime >= existingTime) {
      byPath.set(meta.cwd, {
        path: meta.cwd,
        current: meta.cwd === cwd,
        lastSessionModified: meta.timestamp,
        mcpServerCount: 0,
      });
    }
  }

  return Array.from(byPath.values());
}

function mergeCodexProjects(
  config: CodexConfigShape,
  sessionProjects: AgentProjectEntry[],
  cwd: string,
): AgentProjectEntry[] {
  const byPath = new Map<string, AgentProjectEntry>();
  for (const path of Object.keys(config.projects)) {
    byPath.set(path, {
      path,
      current: path === cwd,
      mcpServerCount: 0,
    });
  }
  for (const project of sessionProjects) {
    byPath.set(project.path, {
      ...byPath.get(project.path),
      ...project,
      current: project.path === cwd,
    });
  }

  const entries = Array.from(byPath.values());
  entries.sort((a, b) => {
    if (a.current && !b.current) return -1;
    if (!a.current && b.current) return 1;
    const aTime = a.lastSessionModified ? Date.parse(a.lastSessionModified) : 0;
    const bTime = b.lastSessionModified ? Date.parse(b.lastSessionModified) : 0;
    if (aTime !== bTime) return bTime - aTime;
    return basename(a.path).localeCompare(basename(b.path));
  });
  return entries.slice(0, 25);
}

async function collectJsonlFiles(dir: string, out: string[]): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await collectJsonlFiles(path, out);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          out.push(path);
        }
      }),
    );
  } catch {
    // sessions are optional
  }
}

async function readCodexSessionMeta(
  path: string,
): Promise<{ cwd?: string; timestamp?: string } | undefined> {
  const firstLine = await readFirstLine(path);
  if (!firstLine) return undefined;
  try {
    const event = JSON.parse(firstLine) as {
      type?: string;
      timestamp?: string;
      payload?: { cwd?: string; timestamp?: string };
    };
    if (event.type !== "session_meta") return undefined;
    return {
      cwd: event.payload?.cwd,
      timestamp: event.payload?.timestamp ?? event.timestamp,
    };
  } catch {
    return undefined;
  }
}

async function readFirstLine(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!bytesRead) return undefined;
    return buffer.toString("utf8", 0, bytesRead).split(/\r?\n/, 1)[0];
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function parseTomlSections(raw: string): Record<string, Record<string, unknown>> {
  const sections: Record<string, Record<string, unknown>> = {};
  let current: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sectionMatch = trimmed.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      current = sectionMatch[1];
      sections[current] ??= {};
      continue;
    }
    if (!current) continue;
    const valueMatch = trimmed.match(/^("[^"]+"|[\w.-]+)\s*=\s*(.+)$/);
    if (!valueMatch) continue;
    sections[current][unquoteToml(valueMatch[1])] = parseTomlValue(valueMatch[2]);
  }
  return sections;
}

function splitTomlSection(section: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < section.length; index += 1) {
    const char = section[index];
    if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (char === "." && !quoted) {
      parts.push(unquoteToml(current));
      current = "";
    } else {
      current += char;
    }
  }
  if (current) parts.push(unquoteToml(current));
  return parts;
}

function parseTomlValue(value: string): unknown {
  const trimmed = stripTomlComment(value.trim());
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const body = trimmed.slice(1, -1).trim();
    if (!body) return [];
    return body
      .split(",")
      .map((item) => parseTomlValue(item.trim()))
      .filter((item): item is string => typeof item === "string");
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return unquoteToml(trimmed);
}

function stripTomlComment(value: string): string {
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') quoted = !quoted;
    if (char === "#" && !quoted) return value.slice(0, index).trim();
  }
  return value;
}

function unquoteToml(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

async function safeReadPreview(
  path: string,
  bytes = PREVIEW_BYTES,
): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8");
    if (content.length <= bytes) return content;
    return `${content.slice(0, bytes)}\n…[truncated]`;
  } catch {
    return undefined;
  }
}
