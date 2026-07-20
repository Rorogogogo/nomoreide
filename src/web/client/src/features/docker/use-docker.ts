import { useCallback, useEffect, useState } from "react";
import {
  getDockerContainers,
  getDockerStatus,
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
