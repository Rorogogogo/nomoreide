import { useEffect, useState } from "react";
import {
  getGitHubTokenInfo,
  type GitHubConnectionStatus,
  type GitHubTokenInfo,
} from "@/lib/api";

export function useGitHubToken() {
  const [configured, setConfigured] = useState(false);
  const [deviceFlowAvailable, setDeviceFlowAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<GitHubConnectionStatus>("checking");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<GitHubTokenInfo | null>(null);

  function refresh() {
    setLoading(true);
    setStatus("checking");
    setError(null);
    void getGitHubTokenInfo()
      .then((info) => {
        setConfigured(info.configured);
        setDeviceFlowAvailable(info.deviceFlowAvailable);
        setStatus(info.status);
        setError(info.error ?? null);
        setInfo(info);
      })
      .catch((caught) => {
        setConfigured(false);
        setDeviceFlowAvailable(false);
        setStatus("connection_error");
        setError(caught instanceof Error ? caught.message : String(caught));
        setInfo(null);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    configured,
    deviceFlowAvailable,
    loading,
    status,
    error,
    info,
    isConnected: status === "connected",
    needsLogin: status === "not_configured" || status === "auth_error",
    refresh,
  };
}
