/**
 * Per-container resource usage via `docker stats --no-stream`. Kept out of
 * `docker.ts` because it's the one Docker read that is genuinely expensive —
 * the daemon samples every running container before it answers — so the UI
 * polls it on its own cadence rather than folding it into the container list.
 */
import { execDocker, parseDockerJsonLines, readString } from "./docker.js";

export interface DockerContainerStats {
  id: string;
  /** Null when Docker reports a non-numeric value (e.g. "--" for a stopped container). */
  cpuPercent: number | null;
  memoryPercent: number | null;
  /** Raw "184MiB / 2GiB" string — shown verbatim, Docker already picked sane units. */
  memoryUsage: string;
  /** Raw "1.2kB / 648B" network I/O string. */
  netIo: string;
  blockIo: string;
}

export async function listDockerStats(): Promise<DockerContainerStats[]> {
  return parseDockerStatsLines(
    await execDocker(["stats", "--no-stream", "--format", "{{json .}}"]),
  );
}

export function parseDockerStatsLines(stdout: string): DockerContainerStats[] {
  return parseDockerJsonLines(stdout, (raw) => {
    const id = readString(raw, "ID") || readString(raw, "Container");
    if (!id) return null;
    return {
      id,
      cpuPercent: parsePercent(readString(raw, "CPUPerc")),
      memoryPercent: parsePercent(readString(raw, "MemPerc")),
      memoryUsage: readString(raw, "MemUsage"),
      netIo: readString(raw, "NetIO"),
      blockIo: readString(raw, "BlockIO"),
    };
  });
}

/** Docker formats percentages as "2.43%", or "--" when it has no sample. */
export function parsePercent(value: string): number | null {
  const parsed = Number.parseFloat(value.replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `docker stats` keys rows by the short (12-char) ID while `docker ps` reports
 * the same short form — but callers may hold either, so match on prefix in
 * whichever direction is longer.
 */
export function indexStatsById(
  stats: DockerContainerStats[],
): Map<string, DockerContainerStats> {
  const index = new Map<string, DockerContainerStats>();
  for (const entry of stats) index.set(entry.id, entry);
  return index;
}

export function findStatsFor(
  index: Map<string, DockerContainerStats>,
  containerId: string,
): DockerContainerStats | undefined {
  const exact = index.get(containerId);
  if (exact) return exact;
  for (const [id, entry] of index) {
    if (id.startsWith(containerId) || containerId.startsWith(id)) return entry;
  }
  return undefined;
}
