import { readdir, readFile, stat } from "node:fs/promises";
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
  scope: "user" | "project" | "plugin";
  path: string;
  description?: string;
}

export interface AgentMcpServer {
  name: string;
  scope: "user" | "project";
  command?: string;
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

export interface AgentInfo {
  detected: {
    name: "claude-code" | "codex" | "gemini" | "unknown";
    label: string;
    signals: string[];
    parentProcess?: string;
  };
  project: {
    cwd: string;
    claudeMdPath?: string;
    claudeMdPreview?: string;
    memoryDir?: string;
    memoryFiles: AgentMemoryFile[];
  };
  skills: AgentSkill[];
  mcpServers: AgentMcpServer[];
  projects: AgentProjectEntry[];
}

const PREVIEW_BYTES = 1200;

export async function buildAgentInfo(cwd: string): Promise<AgentInfo> {
  const detected = await detectAgent();
  const home = homedir();

  const [project, skills, claudeJson] = await Promise.all([
    collectProjectMemory(cwd, home),
    collectSkills(home, cwd),
    readClaudeJson(home),
  ]);

  const mcpServers = collectMcpServers(claudeJson, cwd);
  const projects = collectProjects(claudeJson, cwd);

  return { detected, project, skills, mcpServers, projects };
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

async function collectProjectMemory(
  cwd: string,
  home: string,
): Promise<AgentInfo["project"]> {
  const result: AgentInfo["project"] = {
    cwd,
    memoryFiles: [],
  };

  const claudeMdPath = resolve(cwd, "CLAUDE.md");
  const claudeMdContent = await safeReadPreview(claudeMdPath);
  if (claudeMdContent !== undefined) {
    result.claudeMdPath = claudeMdPath;
    result.claudeMdPreview = claudeMdContent;
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

async function collectSkills(home: string, cwd: string): Promise<AgentSkill[]> {
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

async function readSkillsDir(
  dir: string,
  scope: AgentSkill["scope"],
  out: AgentSkill[],
): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
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

async function readClaudeJson(home: string): Promise<ClaudeJsonShape | null> {
  try {
    const raw = await readFile(join(home, ".claude.json"), "utf8");
    return JSON.parse(raw) as ClaudeJsonShape;
  } catch {
    return null;
  }
}

function collectMcpServers(
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
    if (typeof value.type === "string") entry.type = value.type;
    if (typeof value.url === "string") entry.url = value.url;
  }
  return entry;
}

function collectProjects(
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
