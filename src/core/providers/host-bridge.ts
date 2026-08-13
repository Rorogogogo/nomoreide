import type { ConfigStore } from "../config-store.js";
import type { HostSshTarget } from "./host-provider.js";
import { hostProviders } from "./registry.js";

/**
 * Every connected host provider's instances, as SSH targets.
 *
 * This is the bridge §7 of the design plan was written for: the servers list
 * the user already has gains a row per provider instance, and everything
 * downstream — `probeSshServer`, `readRemoteHostMetrics`, the terminal route,
 * the remote service runner — keeps working against a plain
 * `SshServerDefinition` without knowing a provider exists.
 *
 * **Never throws.** A provider that is not connected, whose token has expired,
 * or whose API is down contributes nothing; the user's hand-registered and
 * `~/.ssh/config` hosts must still list. A provider outage is not a reason for
 * the servers page to go blank, and there is nowhere in that page's shape to
 * report one.
 */
export async function hostProviderSshTargets(
  configStore: ConfigStore,
): Promise<HostSshTarget[]> {
  const cached = readCache();
  if (cached) return cached;

  const perProvider = await Promise.all(
    hostProviders.map(async (provider) => {
      try {
        const { provider: client } = await provider.context(configStore);
        const instances = await client.listInstances();
        return instances
          .map((instance) => client.toSshTarget(instance))
          .filter((target): target is HostSshTarget => target !== null);
      } catch {
        return [];
      }
    }),
  );

  const targets = perProvider.flat();
  cache = { at: Date.now(), targets };
  return targets;
}

/**
 * How long a provider's instance list is reused.
 *
 * The servers view reloads on an interval *and* on every window focus, and each
 * reload would otherwise be one API call per connected provider. Instances do
 * not change on a human timescale, so a short window trades staleness nobody
 * notices for not being rate-limited by the vendor. Power actions clear it
 * explicitly, which is the one case where the delay would be visible.
 */
const CACHE_TTL_MS = 30_000;

let cache: { at: number; targets: HostSshTarget[] } | null = null;

function readCache(): HostSshTarget[] | null {
  if (!cache || Date.now() - cache.at >= CACHE_TTL_MS) return null;
  return cache.targets;
}

/** Drops the cache so the next read reflects a change we just made. */
export function invalidateHostSshTargets(): void {
  cache = null;
}
