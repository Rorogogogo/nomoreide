import { useCallback, useSyncExternalStore } from "react";
import {
  getGitHubTokenInfo,
  type GitHubConnectionStatus,
  type GitHubTokenInfo,
} from "@/lib/api";

/**
 * Token state lives in a module-level store rather than per-component
 * `useState` because more than one place renders the connected identity at a
 * time — the header indicator, the GitHub view, and the account selector inside
 * it. With private copies, switching account from the selector refreshed only
 * the view's copy and the header kept a stale avatar until a full page reload.
 * One store means one `refresh()` reaches every consumer.
 */
interface GitHubTokenState {
  configured: boolean;
  deviceFlowAvailable: boolean;
  loading: boolean;
  status: GitHubConnectionStatus;
  error: string | null;
  info: GitHubTokenInfo | null;
}

let state: GitHubTokenState = {
  configured: false,
  deviceFlowAvailable: false,
  loading: true,
  status: "checking",
  error: null,
  info: null,
};

const listeners = new Set<() => void>();
/** The first mount kicks off the initial load; later mounts reuse the state. */
let loadStarted = false;
/**
 * Responses are applied only when they belong to the newest request. Selecting
 * an account fires a refresh while an earlier one may still be in flight, and
 * that older response describes the account we just left.
 */
let requestId = 0;

function setState(patch: Partial<GitHubTokenState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function refreshGitHubToken(): Promise<void> {
  const id = ++requestId;
  setState({ loading: true, status: "checking", error: null });
  return getGitHubTokenInfo()
    .then((info) => {
      if (id !== requestId) return;
      setState({
        configured: info.configured,
        deviceFlowAvailable: info.deviceFlowAvailable,
        loading: false,
        status: info.status,
        error: info.error ?? null,
        info,
      });
    })
    .catch((caught) => {
      if (id !== requestId) return;
      setState({
        configured: false,
        deviceFlowAvailable: false,
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
    void refreshGitHubToken();
  }
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): GitHubTokenState {
  return state;
}

export function useGitHubToken() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refresh = useCallback(() => {
    void refreshGitHubToken();
  }, []);

  return {
    ...snapshot,
    isConnected: snapshot.status === "connected",
    needsLogin: snapshot.status === "not_configured" || snapshot.status === "auth_error",
    refresh,
  };
}
