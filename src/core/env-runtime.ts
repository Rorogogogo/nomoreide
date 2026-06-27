import { stat } from "node:fs/promises";
import { detectConfigFiles, type ConfigFileFormat } from "./config-files.js";

/**
 * A config file (`.env`, `appsettings.json`, `application.yml`) that was edited
 * after the service process started — so the live process is running with the
 * old values baked in.
 */
export interface StaleConfigFile {
  relativePath: string;
  path: string;
  format: ConfigFileFormat;
  modifiedAt: string;
}

export interface RuntimeEnvStatus {
  running: boolean;
  startedAt?: string;
  /** Config files modified after `startedAt` (most-recent first). */
  staleFiles: StaleConfigFile[];
  /** True when a running process is using an out-of-date configuration. */
  stale: boolean;
}

/**
 * A running process bakes in its environment at exec time — the OS gives no way
 * to mutate it in place, so a `.env` edit only takes effect on the next launch.
 * This compares each detected config file's mtime against when the service
 * started so the UI can flag "running stale" and offer a one-click reload,
 * instead of leaving the user to restart-and-pray.
 */
export async function computeRuntimeEnvStatus(input: {
  cwd: string;
  running: boolean;
  startedAt?: string;
}): Promise<RuntimeEnvStatus> {
  const { cwd, running, startedAt } = input;
  if (!running || !startedAt) {
    return { running, startedAt, staleFiles: [], stale: false };
  }
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) {
    return { running, startedAt, staleFiles: [], stale: false };
  }

  const files = await detectConfigFiles(cwd);
  const staleFiles: StaleConfigFile[] = [];
  for (const file of files) {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(file.path)).mtimeMs;
    } catch {
      continue; // vanished between detection and stat — ignore
    }
    // 1s skew guard so a save that races the spawn isn't a false positive.
    if (mtimeMs > startedMs + 1000) {
      staleFiles.push({
        relativePath: file.relativePath,
        path: file.path,
        format: file.format,
        modifiedAt: new Date(mtimeMs).toISOString(),
      });
    }
  }
  staleFiles.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return { running, startedAt, staleFiles, stale: staleFiles.length > 0 };
}
