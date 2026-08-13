import { useCallback, useSyncExternalStore } from "react";
import {
  type ProviderConnectionStatus,
  type ProviderStatusInfo,
} from "@/lib/api";
import {
  getVercelStatus,
} from "../provider-client";

/**
 * Connection state in a module-level store rather than per-component state,
 * for the same reason as `use-github-token`: the header indicator and the
 * Vercel view both render the connected identity, and one `refresh()` has to
 * reach both. Private copies leave one of them stale after a reconnect.
 */
interface VercelStatusState {
  loading: boolean;
  status: ProviderConnectionStatus;
  error: string | null;
  info: ProviderStatusInfo | null;
}

let state: VercelStatusState = {
  loading: true,
  status: "checking",
  error: null,
  info: null,
};

const listeners = new Set<() => void>();
let loadStarted = false;
/** Responses apply only when they belong to the newest request (see GitHub's note). */
let requestId = 0;

function setState(patch: Partial<VercelStatusState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function refreshVercelStatus(): Promise<void> {
  const id = ++requestId;
  setState({ loading: true, status: "checking", error: null });
  return getVercelStatus()
    .then((info) => {
      if (id !== requestId) return;
      setState({
        loading: false,
        status: info.status,
        error: info.error ?? null,
        info,
      });
    })
    .catch((caught) => {
      if (id !== requestId) return;
      setState({
        loading: false,
        status: "connection_error",
        error: caught instanceof Error ? caught.message : String(caught),
        info: null,
      });
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!loadStarted) {
    loadStarted = true;
    void refreshVercelStatus();
  }
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): VercelStatusState {
  return state;
}

export function useVercelStatus() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refresh = useCallback(() => {
    void refreshVercelStatus();
  }, []);

  return {
    ...snapshot,
    isConnected: snapshot.status === "connected",
    needsSetup: snapshot.status === "not_configured",
    refresh,
  };
}
