import { useEffect, useState } from "react";
import { getGitHubTokenInfo } from "@/lib/api";

export function useGitHubToken() {
  const [configured, setConfigured] = useState(false);
  const [deviceFlowAvailable, setDeviceFlowAvailable] = useState(false);
  const [loading, setLoading] = useState(true);

  function refresh() {
    setLoading(true);
    void getGitHubTokenInfo()
      .then((info) => {
        setConfigured(info.configured);
        setDeviceFlowAvailable(info.deviceFlowAvailable);
      })
      .catch(() => { setConfigured(false); setDeviceFlowAvailable(false); })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { configured, deviceFlowAvailable, loading, refresh };
}
