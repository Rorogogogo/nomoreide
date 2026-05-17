import type { ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function readWebAppShell(): Promise<string> {
  for (const path of webAppShellCandidates()) {
    try {
      return await readFile(path, "utf8");
    } catch {
      // Try the next candidate; source index keeps tests and dev fallback readable.
    }
  }

  throw new Error("React web app shell was not found. Run npm run build.");
}

export async function sendStaticAsset(
  response: ServerResponse,
  requestPath: string,
): Promise<boolean> {
  const relativePath = requestPath.replace(/^\/+/, "");
  for (const root of webAssetRoots()) {
    const assetPath = resolve(root, relativePath);
    if (!assetPath.startsWith(root)) {
      continue;
    }

    try {
      const asset = await readFile(assetPath);
      response.writeHead(200, {
        "content-type": contentTypeFor(assetPath),
      });
      response.end(asset);
      return true;
    } catch {
      // Try the next asset root.
    }
  }

  return false;
}

function webAppShellCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(here, "../../dist/web/client/index.html"),
    resolve(here, "client/index.html"),
    resolve(here, "../../src/web/client/index.html"),
  ];
}

function webAssetRoots(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [resolve(here, "client"), resolve(here, "../../dist/web/client")];
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
