import { useCallback, useEffect, useState } from "react";
import {
  getAgentEnvAgents,
  getAgentEnvConfigs,
  getAgentEnvDoctor,
  type AgentEnvAvailability,
  type AgentEnvConfig,
  type AgentEnvDoctorResult,
} from "@/lib/api";

/** Loads availability, live configs, and doctor checks for every agent. */
export function useAgentEnv() {
  const [agents, setAgents] = useState<AgentEnvAvailability[]>([]);
  const [configs, setConfigs] = useState<AgentEnvConfig[]>([]);
  const [doctor, setDoctor] = useState<AgentEnvDoctorResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextAgents, nextConfigs, nextDoctor] = await Promise.all([
        getAgentEnvAgents(),
        getAgentEnvConfigs(),
        getAgentEnvDoctor(),
      ]);
      setAgents(nextAgents);
      setConfigs(nextConfigs);
      setDoctor(nextDoctor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { agents, configs, doctor, loading, error, refresh };
}
