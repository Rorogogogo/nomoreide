import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildAgentInfo } from "../src/web/agent-info.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;
const ORIGINAL_CODEX_SANDBOX = process.env.CODEX_SANDBOX;
const ORIGINAL_CODEX_CLI = process.env.CODEX_CLI;
const ORIGINAL_CLAUDECODE = process.env.CLAUDECODE;
const ORIGINAL_CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT;
const ORIGINAL_CLAUDE_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR;

let tempDir: string | undefined;

afterEach(async () => {
  restoreEnv("HOME", ORIGINAL_HOME);
  restoreEnv("CODEX_HOME", ORIGINAL_CODEX_HOME);
  restoreEnv("CODEX_SANDBOX", ORIGINAL_CODEX_SANDBOX);
  restoreEnv("CODEX_CLI", ORIGINAL_CODEX_CLI);
  restoreEnv("CLAUDECODE", ORIGINAL_CLAUDECODE);
  restoreEnv("CLAUDE_CODE_ENTRYPOINT", ORIGINAL_CLAUDE_CODE_ENTRYPOINT);
  restoreEnv("CLAUDE_PROJECT_DIR", ORIGINAL_CLAUDE_PROJECT_DIR);
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("agent info", () => {
  test("builds Codex skills, MCP servers, project memory, and recent projects", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nomoreide-agent-info-"));
    const home = join(tempDir, "home");
    const cwd = join(tempDir, "project");
    const codexHome = join(home, ".codex");

    await mkdir(join(codexHome, "skills", "reviewer"), { recursive: true });
    await mkdir(join(cwd, ".codex", "skills", "local-skill"), { recursive: true });
    await mkdir(join(codexHome, "sessions", "2026", "05", "27"), { recursive: true });
    await writeFile(
      join(codexHome, "skills", "reviewer", "SKILL.md"),
      "---\ndescription: Review code carefully\n---\n",
    );
    await writeFile(
      join(cwd, ".codex", "skills", "local-skill", "SKILL.md"),
      "---\ndescription: Project-only skill\n---\n",
    );
    await writeFile(join(cwd, "AGENTS.md"), "Use the project instructions.\n");
    await writeFile(
      join(codexHome, "config.toml"),
      [
        `[projects."${cwd}"]`,
        'trust_level = "trusted"',
        "",
        "[mcp_servers.nomoreide]",
        'command = "node"',
        'args = ["dist/index.js"]',
        "",
        "[mcp_servers.remote]",
        'type = "sse"',
        'url = "https://example.test/mcp"',
      ].join("\n"),
    );
    await writeFile(
      join(
        codexHome,
        "sessions",
        "2026",
        "05",
        "27",
        "rollout-2026-05-27T12-00-00-session.jsonl",
      ),
      `${JSON.stringify({
        timestamp: "2026-05-27T12:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "session",
          timestamp: "2026-05-27T12:00:00.000Z",
          cwd,
        },
      })}\n`,
    );

    process.env.HOME = home;
    process.env.CODEX_HOME = codexHome;
    delete process.env.CODEX_SANDBOX;
    delete process.env.CODEX_CLI;
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_PROJECT_DIR;

    const info = await buildAgentInfo(cwd);

    expect(info.detected.name).toBe("codex");
    expect(info.agents.codex.project.instructionFileName).toBe("AGENTS.md");
    expect(info.agents.codex.project.instructionFilePreview).toContain(
      "Use the project instructions.",
    );
    expect(info.agents.codex.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "local-skill",
          scope: "project",
          description: "Project-only skill",
        }),
        expect.objectContaining({
          name: "reviewer",
          scope: "user",
          description: "Review code carefully",
        }),
      ]),
    );
    expect(info.agents.codex.mcpServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "nomoreide", scope: "user", command: "node" }),
        expect.objectContaining({
          name: "remote",
          scope: "user",
          type: "sse",
          url: "https://example.test/mcp",
        }),
      ]),
    );
    expect(info.agents.codex.projects[0]).toMatchObject({
      path: cwd,
      current: true,
      lastSessionModified: "2026-05-27T12:00:00.000Z",
    });
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
