import { afterEach, describe, expect, test, vi } from "vitest";
import {
  clearGitHubCache,
  githubCacheKey,
  readGitHubCache,
  revalidateGitHubCache,
  writeGitHubCache,
} from "../src/web/client/src/features/github/github-cache";

afterEach(() => {
  clearGitHubCache();
});

describe("GitHub view cache", () => {
  test("a write survives to be read back — the point of living outside React", () => {
    writeGitHubCache("repo:prs:open", [{ number: 1 }]);
    expect(readGitHubCache<Array<{ number: number }>>("repo:prs:open")).toEqual([{ number: 1 }]);
  });

  test("a cold miss reads undefined rather than an empty value", () => {
    expect(readGitHubCache("repo:prs:open")).toBeUndefined();
  });

  test("revalidate stores what it loaded", async () => {
    const loaded = await revalidateGitHubCache("repo:prs:open", () => Promise.resolve(["a"]));
    expect(loaded).toEqual(["a"]);
    expect(readGitHubCache("repo:prs:open")).toEqual(["a"]);
  });

  test("concurrent callers share one request", async () => {
    const load = vi.fn().mockResolvedValue(["shared"]);
    const [first, second] = await Promise.all([
      revalidateGitHubCache("repo:prs:open", load),
      revalidateGitHubCache("repo:prs:open", load),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  test("a failed load rejects and leaves the previous value in place", async () => {
    writeGitHubCache("repo:prs:open", ["previous"]);
    await expect(
      revalidateGitHubCache("repo:prs:open", () => Promise.reject(new Error("offline"))),
    ).rejects.toThrow("offline");
    // The view keeps painting the stale list instead of blanking on a blip.
    expect(readGitHubCache("repo:prs:open")).toEqual(["previous"]);
  });

  test("a rejected request is not left in flight", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(["recovered"]);
    await expect(revalidateGitHubCache("repo:prs:open", load)).rejects.toThrow("offline");
    await expect(revalidateGitHubCache("repo:prs:open", load)).resolves.toEqual(["recovered"]);
  });

  test("keys from different repositories never collide", () => {
    writeGitHubCache(githubCacheKey("repo-a", "prs", "open"), ["a"]);
    writeGitHubCache(githubCacheKey("repo-b", "prs", "open"), ["b"]);
    expect(readGitHubCache(githubCacheKey("repo-a", "prs", "open"))).toEqual(["a"]);
    expect(readGitHubCache(githubCacheKey("repo-b", "prs", "open"))).toEqual(["b"]);
  });

  test("the cache is bounded, evicting the least recently written", () => {
    for (let index = 0; index < 130; index++) {
      writeGitHubCache(`repo:pr-diff:${index}`, `diff-${index}`);
    }
    expect(readGitHubCache("repo:pr-diff:0")).toBeUndefined();
    expect(readGitHubCache("repo:pr-diff:129")).toBe("diff-129");
  });

  test("re-writing a key refreshes its place in the eviction order", () => {
    writeGitHubCache("repo:keep", "kept");
    for (let index = 0; index < 119; index++) {
      writeGitHubCache(`repo:filler:${index}`, index);
      writeGitHubCache("repo:keep", "kept");
    }
    expect(readGitHubCache("repo:keep")).toBe("kept");
  });
});
