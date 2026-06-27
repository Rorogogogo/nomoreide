import { useCallback, useEffect, useState } from "react";
import { useToasts } from "@/components/ui/toast";
import { getServiceEnvRuntime, restartService, type RuntimeEnvStatus } from "@/lib/api";

/**
 * Tracks whether a running service is using a stale configuration (a `.env` /
 * config file was edited after it started) and offers a one-click reload that
 * re-launches the process so the edits actually take effect — a live process's
 * environment can't be mutated in place.
 *
 * Degrades silently when the runtime endpoint is unavailable (e.g. the desktop
 * app has no Node backend), so the banner simply never appears there.
 */
export function useServiceEnvRuntime(serviceName: string) {
  const { error: showError, success: showSuccess } = useToasts();
  const [runtime, setRuntime] = useState<RuntimeEnvStatus | undefined>();
  const [reloading, setReloading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setRuntime(await getServiceEnvRuntime(serviceName));
    } catch {
      setRuntime(undefined);
    }
  }, [serviceName]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reload = useCallback(async () => {
    setReloading(true);
    try {
      await restartService(serviceName);
      showSuccess(`Reloaded ${serviceName} with the latest configuration.`);
      await refresh();
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setReloading(false);
    }
  }, [serviceName, refresh, showError, showSuccess]);

  return { runtime, reloading, refresh, reload };
}
