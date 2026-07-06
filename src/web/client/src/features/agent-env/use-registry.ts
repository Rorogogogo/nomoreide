import { useCallback, useEffect, useRef, useState } from "react";
import {
  getRegistryAuthOutcome,
  getRegistryAuthStatus,
  installAgentEnvProfileFromRegistry,
  publishAgentEnvProfile,
  registryLogout,
  startRegistryAuth,
  type AgentEnvRegistryStatus,
} from "@/lib/api";
import { useToasts } from "@/components/ui/toast";

const AUTH_POLL_INTERVAL_MS = 1500;
const AUTH_POLL_TIMEOUT_MS = 5 * 60 * 1000;

export interface PublishFormInput {
  name: string;
  slug: string;
  title: string;
  summary?: string;
  version?: string;
}

/**
 * Hosted profile registry (ROR-63): sign-in status, the browser sign-in
 * round-trip (open platform tab → poll outcome), install-by-slug, publish.
 */
export function useRegistry(onProfilesChanged: () => void) {
  const [status, setStatus] = useState<AgentEnvRegistryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const pollStop = useRef(false);
  const toasts = useToasts();

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await getRegistryAuthStatus());
    } catch {
      // registry status is non-critical; the bar renders a signed-out state
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    return () => {
      pollStop.current = true;
    };
  }, [refreshStatus]);

  const signIn = useCallback(async () => {
    if (signingIn) return;
    setSigningIn(true);
    try {
      const { url, state } = await startRegistryAuth();
      window.open(url, "_blank", "noopener");
      const deadline = Date.now() + AUTH_POLL_TIMEOUT_MS;
      while (Date.now() < deadline && !pollStop.current) {
        await new Promise((resolve) => setTimeout(resolve, AUTH_POLL_INTERVAL_MS));
        const outcome = await getRegistryAuthOutcome(state).catch(() => null);
        if (!outcome || outcome.status === "pending") continue;
        if (outcome.status === "success") {
          toasts.success("Signed in to the profile registry");
        } else {
          toasts.error(outcome.message ?? "Registry sign-in failed");
        }
        await refreshStatus();
        return;
      }
      if (!pollStop.current) toasts.error("Registry sign-in timed out");
    } catch (caught) {
      toasts.error(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSigningIn(false);
    }
  }, [refreshStatus, signingIn, toasts]);

  const run = useCallback(
    async (operation: () => Promise<void>): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      try {
        await operation();
        return true;
      } catch (caught) {
        toasts.error(caught instanceof Error ? caught.message : String(caught));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, toasts],
  );

  const signOut = useCallback(
    () =>
      run(async () => {
        await registryLogout();
        toasts.success("Signed out of the profile registry");
        await refreshStatus();
      }),
    [refreshStatus, run, toasts],
  );

  const install = useCallback(
    (slug: string) =>
      run(async () => {
        try {
          const result = await installAgentEnvProfileFromRegistry({ slug });
          toasts.success(installSummary(result.name, result.missingCredentials.length));
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          if (!message.includes("already exists")) throw caught;
          const result = await installAgentEnvProfileFromRegistry({ slug, force: true });
          toasts.success(
            `${installSummary(result.name, result.missingCredentials.length)} (overwrote existing)`,
          );
        }
        onProfilesChanged();
      }),
    [onProfilesChanged, run, toasts],
  );

  const publish = useCallback(
    (input: PublishFormInput) =>
      run(async () => {
        const result = await publishAgentEnvProfile(input);
        toasts.message({
          text: `Published "${result.slug}" v${result.version} to the registry (credentials redacted)`,
          preserve: true,
        });
      }),
    [run, toasts],
  );

  return { status, busy, signingIn, refreshStatus, signIn, signOut, install, publish };
}

function installSummary(name: string, missingCount: number): string {
  return missingCount > 0
    ? `Installed "${name}" — ${missingCount} credential${missingCount === 1 ? "" : "s"} still needed`
    : `Installed "${name}" from the registry`;
}
