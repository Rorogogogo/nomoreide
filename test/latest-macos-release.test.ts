import { describe, expect, test, vi } from "vitest";
import { findLatestMacosRelease } from "../apps/website/src/lib/latest-macos-release";

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("latest macOS release", () => {
  test("skips newer source-only releases and selects the newest universal DMG", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      response([
        { tag_name: "v0.1.89", draft: false, prerelease: false, assets: [] },
        {
          tag_name: "desktop-v0.1.88",
          draft: false,
          prerelease: false,
          assets: [
            {
              name: "NoMoreIDE_0.1.88_universal.dmg",
              browser_download_url: "https://example.test/nomoreide-universal.dmg",
            },
          ],
        },
      ]),
    );

    await expect(findLatestMacosRelease(fetcher)).resolves.toEqual({
      downloadUrl: "https://example.test/nomoreide-universal.dmg",
      version: "0.1.88",
    });
  });

  test("ignores drafts, prereleases, and non-DMG assets", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      response([
        {
          tag_name: "v0.2.0",
          draft: true,
          prerelease: false,
          assets: [
            { name: "NoMoreIDE.dmg", browser_download_url: "https://example.test/draft.dmg" },
          ],
        },
        {
          tag_name: "v0.1.90-beta.1",
          draft: false,
          prerelease: true,
          assets: [
            { name: "NoMoreIDE.dmg", browser_download_url: "https://example.test/beta.dmg" },
          ],
        },
        {
          tag_name: "v0.1.89",
          draft: false,
          prerelease: false,
          assets: [
            { name: "NoMoreIDE.tar.gz", browser_download_url: "https://example.test/app.tar.gz" },
          ],
        },
      ]),
    );

    await expect(findLatestMacosRelease(fetcher)).resolves.toBeNull();
  });

  test("fails clearly when GitHub returns an error", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({}, false, 403));

    await expect(findLatestMacosRelease(fetcher)).rejects.toThrow(
      "GitHub releases request failed with 403.",
    );
  });
});
