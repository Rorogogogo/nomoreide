import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { listDirectories, parentOf, WINDOWS_DRIVES_ROOT } from "../src/web/directories";

const originalPlatform = process.platform;

function stubPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

describe("listDirectories", () => {
  test("lists folders first, ignoring .git/node_modules, with a real parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "nmi-dirs-"));
    await mkdir(join(root, "src"));
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "readme.txt"), "hi");

    const listing = await listDirectories(root);

    expect(listing.path).toBe(root);
    expect(listing.parent).not.toBe(root);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["src"]);
  });

  test("includes files when asked", async () => {
    const root = await mkdtemp(join(tmpdir(), "nmi-dirs-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "readme.txt"), "hi");

    const listing = await listDirectories(root, { includeFiles: true });

    expect(listing.entries.map((entry) => entry.name)).toEqual(["src", "readme.txt"]);
  });

  describe("parentOf (Windows path semantics, stubbed on any host)", () => {
    test("a drive root's parent is the 'This PC' sentinel, not itself", () => {
      stubPlatform("win32");
      // The bug: win32.dirname("C:\\") === "C:\\" would dead-end the picker.
      expect(parentOf("C:\\")).toBe(WINDOWS_DRIVES_ROOT);
      expect(parentOf("D:\\")).toBe(WINDOWS_DRIVES_ROOT);
    });

    test("a nested folder still walks up normally", () => {
      stubPlatform("win32");
      expect(parentOf("C:\\Users\\foo\\proj")).toBe("C:\\Users\\foo");
    });

    test("POSIX hosts are unaffected — root's parent is itself", () => {
      stubPlatform("darwin");
      expect(parentOf("/")).toBe("/");
      expect(parentOf("/Users/foo/proj")).toBe("/Users/foo");
    });
  });

  test("on Windows, the drives-root sentinel enumerates drives instead of the filesystem", async () => {
    stubPlatform("win32");

    const listing = await listDirectories(WINDOWS_DRIVES_ROOT);

    // Its own parent — this is the top of the tree, so the picker hides "up".
    expect(listing.path).toBe(WINDOWS_DRIVES_ROOT);
    expect(listing.parent).toBe(WINDOWS_DRIVES_ROOT);
    // No `C:\` drives exist on the CI/dev host, so the list resolves empty —
    // the point is it never touched the real filesystem or threw.
    expect(Array.isArray(listing.entries)).toBe(true);
  });
});
