export const RELEASES_URL = "https://github.com/Rorogogogo/nomoreide/releases";

const RELEASES_API_URL =
  "https://api.github.com/repos/Rorogogogo/nomoreide/releases?per_page=20";

interface GitHubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface GitHubRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

export interface MacosRelease {
  downloadUrl: string;
  version: string;
}

/**
 * Find the newest published release that actually contains a macOS DMG.
 * GitHub's `/releases/latest` can point at a source-only release, so the
 * website must select by artifact rather than assuming every release has one.
 */
export async function findLatestMacosRelease(
  fetcher: typeof fetch = fetch,
): Promise<MacosRelease | null> {
  const response = await fetcher(RELEASES_API_URL, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub releases request failed with ${response.status}.`);
  }

  const releases: unknown = await response.json();
  if (!Array.isArray(releases)) throw new Error("GitHub releases response was not an array.");

  for (const release of releases as GitHubRelease[]) {
    if (release.draft === true || release.prerelease === true || !Array.isArray(release.assets)) {
      continue;
    }

    const dmgAssets = (release.assets as GitHubReleaseAsset[]).filter(
      (asset) =>
        typeof asset.name === "string" &&
        asset.name.toLowerCase().endsWith(".dmg") &&
        typeof asset.browser_download_url === "string",
    );
    const asset =
      dmgAssets.find((candidate) =>
        (candidate.name as string).toLowerCase().includes("universal"),
      ) ?? dmgAssets[0];
    if (!asset) continue;

    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    return {
      downloadUrl: asset.browser_download_url as string,
      version: tag.replace(/^(?:desktop-)?v/, ""),
    };
  }

  return null;
}
