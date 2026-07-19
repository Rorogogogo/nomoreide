import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  readAgentSettings,
  setAgentModel,
  writeAgentSettings,
} from "../src/core/agent-settings.js";
import {
  maskSecrets,
  SECRET_MASK,
} from "../src/web/client/src/features/agent-env/mask-secrets.js";

describe("agent settings", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "nomoreide-agent-settings-"));
  });

  it("reads a missing file as exists: false with empty content", async () => {
    const settings = await readAgentSettings("claude", { homeDir });
    expect(settings.exists).toBe(false);
    expect(settings.content).toBe("");
    expect(settings.format).toBe("json");
    expect(settings.model).toBeUndefined();
    expect(settings.path).toBe(path.join(homeDir, ".claude", "settings.json"));
  });

  it("parses the model from claude settings.json", async () => {
    await mkdir(path.join(homeDir, ".claude"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".claude", "settings.json"),
      JSON.stringify({ model: "opus", permissions: {} }),
    );
    const settings = await readAgentSettings("claude", { homeDir });
    expect(settings.exists).toBe(true);
    expect(settings.model).toBe("opus");
  });

  it("parses the root model from codex config.toml", async () => {
    await mkdir(path.join(homeDir, ".codex"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".codex", "config.toml"),
      '# comment\nmodel = "gpt-5-codex"\n\n[mcp_servers.github]\ncommand = "npx"\n',
    );
    const settings = await readAgentSettings("codex", { homeDir });
    expect(settings.format).toBe("toml");
    expect(settings.model).toBe("gpt-5-codex");
  });

  it("rejects writes that do not parse", async () => {
    await expect(writeAgentSettings("claude", "{ nope", { homeDir })).rejects.toThrow(
      /Not valid JSON/,
    );
    await expect(writeAgentSettings("codex", "model = [broken", { homeDir })).rejects.toThrow(
      /Not valid TOML/,
    );
  });

  it("backs up the existing file before writing", async () => {
    const dir = path.join(homeDir, ".claude");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "settings.json"), '{"model":"opus"}\n');

    const result = await writeAgentSettings("claude", '{"model":"sonnet"}', { homeDir });
    expect(result.backup).toMatch(/settings\.json\.bak\./);
    expect(await readFile(result.backup!, "utf8")).toBe('{"model":"opus"}\n');
    expect(result.model).toBe("sonnet");
    // Content is newline-terminated on disk.
    expect(await readFile(path.join(dir, "settings.json"), "utf8")).toBe('{"model":"sonnet"}\n');
  });

  it("creates the file (and directory) on first write", async () => {
    const result = await writeAgentSettings("claude", "{}", { homeDir });
    expect(result.exists).toBe(true);
    expect(result.backup).toBeNull();
    const entries = await readdir(path.join(homeDir, ".claude"));
    expect(entries).toContain("settings.json");
  });

  it("sets the model in claude settings.json without touching other keys", async () => {
    const dir = path.join(homeDir, ".claude");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }, null, 2),
    );

    const result = await setAgentModel("claude", "opus", { homeDir });
    expect(result.model).toBe("opus");
    const parsed = JSON.parse(result.content);
    expect(parsed.permissions.defaultMode).toBe("acceptEdits");
  });

  it("replaces only the root model line in codex config.toml", async () => {
    const dir = path.join(homeDir, ".codex");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "config.toml"),
      '# my config\nmodel = "gpt-5"\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n',
    );

    const result = await setAgentModel("codex", "gpt-5-codex", { homeDir });
    expect(result.model).toBe("gpt-5-codex");
    expect(result.content).toContain("# my config");
    expect(result.content).toContain('model = "gpt-5-codex"');
    // The model under [profiles.fast] is a different key and must survive.
    expect(result.content).toContain('model = "gpt-5-mini"');
  });

  it("inserts a root model line before any section when absent", async () => {
    const dir = path.join(homeDir, ".codex");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "config.toml"),
      '[mcp_servers.github]\ncommand = "npx"\n',
    );

    const result = await setAgentModel("codex", "gpt-5-codex", { homeDir });
    expect(result.content.startsWith('model = "gpt-5-codex"\n')).toBe(true);
    expect(result.model).toBe("gpt-5-codex");
  });

  it("refuses model switching for antigravity", async () => {
    await expect(setAgentModel("antigravity", "gemini-3-pro", { homeDir })).rejects.toThrow(
      /isn't supported/,
    );
  });
});

describe("maskSecrets (settings dialog display)", () => {
  it("masks secret-keyed values in JSON, leaving other values intact", () => {
    const input = JSON.stringify(
      { model: "opus", env: { GITHUB_TOKEN: "ghp_abc123", EDITOR: "vim" } },
      null,
      2,
    );
    const output = maskSecrets(input);
    expect(output).not.toContain("ghp_abc123");
    expect(output).toContain(`"GITHUB_TOKEN": "${SECRET_MASK}"`);
    expect(output).toContain('"model": "opus"');
    expect(output).toContain('"EDITOR": "vim"');
  });

  it("masks secret-keyed values in TOML root and table entries", () => {
    const input = 'model = "gpt-5"\napi_key = "sk-live-1"\n[mcp_servers.gh]\nSECRET = "hunter2"\n';
    const output = maskSecrets(input);
    expect(output).not.toContain("sk-live-1");
    expect(output).not.toContain("hunter2");
    expect(output).toContain('model = "gpt-5"');
    expect(output).toContain(`api_key = "${SECRET_MASK}"`);
  });

  it("matches token/key/secret/password/credential case-insensitively", () => {
    const input = '{"MyPassword": "a", "credentialFile": "b", "apiKey": "c"}';
    const output = maskSecrets(input);
    expect(output).not.toMatch(/"(a|b|c)"/);
  });

  it("leaves empty values and secret-free files unchanged", () => {
    expect(maskSecrets('{"GITHUB_TOKEN": ""}')).toBe('{"GITHUB_TOKEN": ""}');
    const clean = '{"model": "opus", "language": "en"}';
    expect(maskSecrets(clean)).toBe(clean);
  });

  it("masks the whole value even when it contains escaped quotes", () => {
    const output = maskSecrets('{"TOKEN": "ab\\"cd"}');
    expect(output).toBe(`{"TOKEN": "${SECRET_MASK}"}`);
  });
});
