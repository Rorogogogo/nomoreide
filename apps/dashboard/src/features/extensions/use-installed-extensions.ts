import { useCallback, useEffect, useState } from "react";
import { fetchInstalledExtensions, type InstalledExtension } from "@/lib/api/extensions";

/**
 * The installed-extension inventory.
 *
 * Plain component state rather than a module-level store: unlike provider
 * connection status, nothing else on the page renders this, and it only changes
 * when an extension is installed or removed — neither of which stage 2 can do.
 * A store here would be machinery with one reader.
 */
export function useInstalledExtensions() {
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setExtensions(await fetchInstalledExtensions());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { extensions, loading, error, refresh };
}
