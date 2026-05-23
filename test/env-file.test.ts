import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  entriesFromLines,
  looksSecret,
  mergeEntries,
  parseEnvFile,
  readEnvFile,
  serializeEnvLines,
  writeEnvFile,
} from "../src/core/env-file.js";

describe("env-file", () => {
  it("parses kv, comments, and blank lines", () => {
    const lines = parseEnvFile(`# header\nFOO=bar\n\nBAZ="quoted value"\nQUOTED='single'`);
    expect(lines).toEqual([
      { kind: "raw", text: "# header" },
      { kind: "kv", key: "FOO", value: "bar", quote: "" },
      { kind: "raw", text: "" },
      { kind: "kv", key: "BAZ", value: "quoted value", quote: '"' },
      { kind: "kv", key: "QUOTED", value: "single", quote: "'" },
    ]);
  });

  it("serializes round-trip preserving quotes", () => {
    const text = `# top\nA=1\nB="two words"\n`;
    expect(serializeEnvLines(parseEnvFile(text))).toBe(text);
  });

  it("merges updates while keeping comments and ordering", () => {
    const existing = parseEnvFile(`# group A\nFOO=old\nBAR=keep\n# group B\nGONE=x`);
    const merged = mergeEntries(existing, [
      { key: "FOO", value: "new" },
      { key: "BAR", value: "keep" },
      { key: "NEW", value: "added" },
    ]);
    expect(entriesFromLines(merged)).toEqual([
      { key: "FOO", value: "new" },
      { key: "BAR", value: "keep" },
      { key: "NEW", value: "added" },
    ]);
    const serialized = serializeEnvLines(merged);
    expect(serialized).toContain("# group A");
    expect(serialized).toContain("# group B");
    expect(serialized).not.toContain("GONE");
    expect(serialized).toContain("FOO=new");
    expect(serialized).toContain("NEW=added");
  });

  it("auto-quotes values with whitespace or hash", () => {
    const merged = mergeEntries([], [
      { key: "PLAIN", value: "abc" },
      { key: "SPACED", value: "with space" },
      { key: "HASHED", value: "x#y" },
      { key: "EMPTY", value: "" },
    ]);
    const text = serializeEnvLines(merged);
    expect(text).toContain("PLAIN=abc\n");
    expect(text).toContain('SPACED="with space"\n');
    expect(text).toContain('HASHED="x#y"\n');
    expect(text).toContain('EMPTY=""\n');
  });

  it("reads missing file as empty without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "envfile-"));
    const result = await readEnvFile(join(dir, ".env"));
    expect(result.exists).toBe(false);
    expect(result.lines).toEqual([]);
  });

  it("writes and reads back a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "envfile-"));
    const path = join(dir, ".env");
    await writeFile(path, `# saved\nA=1\n`);
    const initial = await readEnvFile(path);
    const merged = mergeEntries(initial.lines, [
      { key: "A", value: "2" },
      { key: "B", value: "added" },
    ]);
    await writeEnvFile(path, merged);
    const text = await readFile(path, "utf8");
    expect(text).toContain("# saved");
    expect(text).toContain("A=2");
    expect(text).toContain("B=added");
  });

  it("flags secret-like keys", () => {
    expect(looksSecret("API_KEY")).toBe(true);
    expect(looksSecret("DB_PASSWORD")).toBe(true);
    expect(looksSecret("AUTH_TOKEN")).toBe(true);
    expect(looksSecret("PORT")).toBe(false);
    expect(looksSecret("HOST")).toBe(false);
  });
});
