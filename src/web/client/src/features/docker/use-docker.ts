import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getDockerContainers,
  getDockerStats,
  getDockerStatus,
  type DockerContainerStats,
  type DockerContainerSummary,
  type DockerStatus,
} from "@/lib/api";

export function useDocker() {
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [containers, setContainers] = useState<DockerContainerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextStatus = await getDockerStatus();
      setStatus(nextStatus);
      setContainers(nextStatus.available ? await getDockerContainers() : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, containers, loading, error, refresh };
}

/**
 * `docker stats` is the one expensive Docker read — the daemon samples every
 * running container before answering — so it polls on its own slow cadence,
 * separately from the container list, and stays silent about failures: a
 * missing CPU number should never replace the container list with an error.
 */
export function useDockerStats(enabled: boolean, intervalMs = 5000) {
  const [stats, setStats] = useState<Map<string, DockerContainerStats>>(new Map());
  // Avoids a slow sample landing after the tab unmounts or Docker goes away.
  const activeRef = useRef(enabled);
  activeRef.current = enabled;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const sample = async () => {
      try {
        const rows = await getDockerStats();
        if (cancelled || !activeRef.current) return;
        setStats(new Map(rows.map((row) => [row.id, row])));
      } catch {
        // Leave the last good sample in place rather than blanking the column.
      }
    };

    void sample();
    const timer = setInterval(() => void sample(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, intervalMs]);

  /**
   * `docker ps` and `docker stats` both report the 12-char short ID, but a
   * caller may hold the full 64-char one — match on prefix either way.
   */
  return useCallback(
    (containerId: string): DockerContainerStats | undefined => {
      const exact = stats.get(containerId);
      if (exact) return exact;
      for (const [id, entry] of stats) {
        if (id.startsWith(containerId) || containerId.startsWith(id)) return entry;
      }
      return undefined;
    },
    [stats],
  );
}

export interface DockerContainerGroup {
  project: string | null;
  containers: DockerContainerSummary[];
}

/** Compose stacks first (alphabetical), then ungrouped containers last. */
export function groupDockerContainers(
  containers: DockerContainerSummary[],
): DockerContainerGroup[] {
  const byProject = new Map<string, DockerContainerSummary[]>();
  const ungrouped: DockerContainerSummary[] = [];

  for (const container of containers) {
    if (!container.project) {
      ungrouped.push(container);
      continue;
    }
    const group = byProject.get(container.project) ?? [];
    group.push(container);
    byProject.set(container.project, group);
  }

  const groups: DockerContainerGroup[] = [...byProject.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([project, projectContainers]) => ({ project, containers: projectContainers }));

  if (ungrouped.length) groups.push({ project: null, containers: ungrouped });
  return groups;
}

/** Lazily loads one of the non-container resource lists when its tab opens. */
export function useDockerResource<T>(
  load: () => Promise<T[]>,
  enabled: boolean,
): { rows: T[]; loading: boolean; error: string | null; reload: () => Promise<void> } {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await loadRef.current());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  return useMemo(() => ({ rows, loading, error, reload }), [rows, loading, error, reload]);
}
