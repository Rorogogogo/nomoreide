import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ProviderConnectionStatus, ProviderStatusInfo } from "@/lib/api";
import { providerApi, useProviderId } from "../provider-client";

/**
 * Connection state in a module-level store rather than per-component state,
 * for the same reason as `use-github-token`: the header indicator and the
 * deploy view both render the connected identity, and one `refresh()` has to
 * reach both. Private copies leave one of them stale after a reconnect.
 *
 * **Keyed by provider id**, because the switcher means two providers can be
 * connected at once and each has its own connection, scopes and linked project.
 * A single store would have shown Cloudflare's status under Vercel's name for
 * one frame after every switch.
 */
interface ProviderStatusState {
  loading: boolean;
  status: ProviderConnectionStatus;
  error: string | null;
  info: ProviderStatusInfo | null;
}

const INITIAL: ProviderStatusState = {
  loading: true,
  status: "checking",
  error: null,
  info: null,
};

const states = new Map<string, ProviderStatusState>();
const listeners = new Map<string, Set<() => void>>();
const loadStarted = new Set<string>();
/** Responses apply only when they belong to the newest request (see GitHub's note). */
const requestIds = new Map<string, number>();

/**
 * Returned by `getSnapshot`, so it must be the *same object* until something
 * actually changes — `useSyncExternalStore` re-renders forever otherwise.
 */
function getState(providerId: string): ProviderStatusState {
  return states.get(providerId) ?? INITIAL;
}

function setState(providerId: string, patch: Partial<ProviderStatusState>) {
  states.set(providerId, { ...getState(providerId), ...patch });
  for (const listener of listeners.get(providerId) ?? []) listener();
}

export function refreshProviderStatus(providerId: string): Promise<void> {
  const id = (requestIds.get(providerId) ?? 0) + 1;
  requestIds.set(providerId, id);
  setState(providerId, { loading: true, status: "checking", error: null });

  return providerApi(providerId)
    .getStatus()
    .then((info) => {
      if (id !== requestIds.get(providerId)) return;
      setState(providerId, {
        loading: false,
        status: info.status,
        error: info.error ?? null,
        info,
      });
    })
    .catch((caught) => {
      if (id !== requestIds.get(providerId)) return;
      setState(providerId, {
        loading: false,
        status: "connection_error",
        error: caught instanceof Error ? caught.message : String(caught),
        info: null,
      });
    });
}

export function useProviderStatus() {
  const providerId = useProviderId();

  const subscribe = useCallback(
    (listener: () => void) => {
      let set = listeners.get(providerId);
      if (!set) {
        set = new Set();
        listeners.set(providerId, set);
      }
      set.add(listener);

      if (!loadStarted.has(providerId)) {
        loadStarted.add(providerId);
        void refreshProviderStatus(providerId);
      }
      return () => {
        set?.delete(listener);
      };
    },
    [providerId],
  );

  const getSnapshot = useCallback(() => getState(providerId), [providerId]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refresh = useCallback(() => {
    void refreshProviderStatus(providerId);
  }, [providerId]);

  return useMemo(
    () => ({
      ...snapshot,
      isConnected: snapshot.status === "connected",
      needsSetup: snapshot.status === "not_configured",
      refresh,
    }),
    [snapshot, refresh],
  );
}
