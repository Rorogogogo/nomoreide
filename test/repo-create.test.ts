import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository, sanitizeProjectName } from "../src/core/repo-create.js";

describe("repo-create", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nomoreide-create-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("sanitizes names into a single safe segment", () => {
    expect(sanitizeProjectName("  My Project!  ")).toBe("My-Project");
    expect(sanitizeProjectName("a/b")).toBe("a-b");
    expect(() => sanitizeProjectName("   ")).toThrow(/required/);
  });

  it("creates a git-initialised directory with a README", async () => {
    const created = await createRepository("demo app", root);
    expect(created.name).toBe("demo-app");
    expect(created.path).toBe(join(root, "demo-app"));
    expect((await stat(join(created.path, ".git"))).isDirectory()).toBe(true);
    expect(await readFile(join(created.path, "README.md"), "utf8")).toBe("# demo-app\n");
  });

  it("refuses to write into a non-empty destination", async () => {
    const existing = join(root, "taken");
    await createRepository("taken", root);
    await writeFile(join(existing, "keep.txt"), "mine", "utf8");
    await expect(createRepository("taken", root)).rejects.toThrow(/not empty/);
  });
});
