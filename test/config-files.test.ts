import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigFilePathError,
  detectConfigFiles,
  formatFromName,
  resolveConfigFile,
  validateJson,
} from "../src/core/config-files.js";

describe("config-files", () => {
  it("classifies known formats by name", () => {
    expect(formatFromName(".env")).toBe("env");
    expect(formatFromName(".env.local")).toBe("env");
    expect(formatFromName(".env.development")).toBe("env");
    expect(formatFromName("appsettings.json")).toBe("json");
    expect(formatFromName("appsettings.Development.json")).toBe("json");
    expect(formatFromName("application.yml")).toBe("yaml");
    expect(formatFromName("application-prod.yaml")).toBe("yaml");
    expect(formatFromName("random.txt")).toBeUndefined();
  });

  it("detects config files in a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "config-files-"));
    await writeFile(join(dir, ".env"), "");
    await writeFile(join(dir, ".env.local"), "");
    await writeFile(join(dir, "appsettings.json"), "{}");
    await writeFile(join(dir, "appsettings.Development.json"), "{}");
    await writeFile(join(dir, "application.yml"), "");
    await writeFile(join(dir, "README.md"), "");

    const files = await detectConfigFiles(dir);
    const names = files.map((file) => file.relativePath);
    expect(names).toContain(".env");
    expect(names).toContain(".env.local");
    expect(names).toContain("appsettings.json");
    expect(names).toContain("appsettings.Development.json");
    expect(names).toContain("application.yml");
    expect(names).not.toContain("README.md");
  });

  it("scans recursively but skips ignored directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "config-files-rec-"));
    await writeFile(join(dir, ".env"), "");
    await mkdir(join(dir, "src", "config"), { recursive: true });
    await writeFile(join(dir, "src", "config", "appsettings.json"), "{}");
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", ".env"), "");
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "dist", ".env"), "");

    const files = await detectConfigFiles(dir);
    const paths = files.map((file) => file.relativePath);
    expect(paths).toContain(".env");
    expect(paths.some((p) => p.endsWith("appsettings.json"))).toBe(true);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths.some((p) => p.startsWith("dist"))).toBe(false);
  });

  it("rejects paths outside the service directory", () => {
    const cwd = "/tmp/service";
    expect(() => resolveConfigFile(cwd, "../escape/.env")).toThrow(ConfigFilePathError);
    expect(() => resolveConfigFile(cwd, "/etc/passwd")).toThrow(ConfigFilePathError);
  });

  it("rejects unsupported file names", () => {
    expect(() => resolveConfigFile("/tmp/service", "random.txt")).toThrow(ConfigFilePathError);
  });

  it("validates JSON", () => {
    expect(() => validateJson('{"a":1}')).not.toThrow();
    expect(() => validateJson("{not json")).toThrow(/Invalid JSON/);
  });
});
