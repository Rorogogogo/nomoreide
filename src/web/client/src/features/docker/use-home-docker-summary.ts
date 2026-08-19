import { useEffect, useState } from "react";
import {
  getDockerContainers,
  getDockerStatus,
  type DockerContainerSummary,
  type DockerStatus,
} from "@/lib/api";

export interface HomeDockerSummary {
  containers: DockerContainerSummary[];
  containersLoaded: boolean;
  loaded: boolean;
  status: DockerStatus | null;
}

const EMPTY: HomeDockerSummary = {
  containers: [],
  containersLoaded: false,
  loaded: false,
  status: null,
};

const POLL_MS = 30_000;

/** Lightweight Docker presence/container summary for Home. */
export function useHomeDockerSummary(pollMs = POLL_MS): HomeDockerSummary {
  const [summary, setSummary] = useState<HomeDockerSummary>(EMPTY);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const status = await getDockerStatus().catch(() => null);
      if (!active) return;
      if (!status?.available) {
        setSummary({ containers: [], containersLoaded: false, loaded: true, status });
        return;
      }

      try {
        const containers = await getDockerContainers();
        if (active) setSummary({ containers, containersLoaded: true, loaded: true, status });
      } catch {
        if (active) setSummary({ containers: [], containersLoaded: false, loaded: true, status });
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), pollMs);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [pollMs]);

  return summary;
}
