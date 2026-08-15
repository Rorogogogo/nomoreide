import type { SshServerDefinition } from "../types.js";
import type { ProviderAccount } from "./deploy-provider.js";
import type { ProviderApiSpec } from "./egress.js";
import type { ProviderStrings } from "./strings.js";

/**
 * The contract an infrastructure host implements — Vultr today, DigitalOcean
 * and Hetzner next.
 *
 * This is the *second* contract, and it exists because the first one could not
 * hold it. A Vultr instance has no projects, no deployments, no build logs and
 * no environment variables; what it has is an address, a power state, and a
 * shell. One `Plugin` interface wide enough for both would have been a union of
 * two disjoint halves, so `DeployProvider` and `HostProvider` stay separate and
 * narrow — see §2 of `docs/plans/2026-08-13-provider-registry-design.md`.
 *
 * What the two contracts *do* share is deliberately shared rather than
 * re-declared: {@link ProviderAccount}, the whole of `providers/credentials.ts`
 * (a host provider's token resolves through the same three-source model), and
 * the read-safe / write-capable split. That overlap is the evidence the
 * provider layer generalized rather than just being renamed.
 *
 * {@link HostProvider.toSshTarget} is why this contract earns its keep: a
 * provider instance becomes a row in the SSH server list the user already has,
 * with the existing probe, metrics and terminal working against it, without
 * anyone registering it by hand.
 */

/**
 * Normalized power state, chosen — like {@link
 * import("./deploy-provider.js").ProviderDeploymentState} — to be the
 * intersection that drives an icon and a filter. Anything finer belongs in
 * `rawState`.
 *
 * There is no `suspended`: a vendor lock (Vultr's `suspended`, and whatever
 * each other IaaS calls it) is something the user must act on, which is what
 * `error` already means to the UI, and the vendor's own word survives in
 * `rawState`. That is the pressure valve the deploy contract added on day one
 * and this one inherits.
 */
export type HostInstanceState =
  | "running"
  | "stopped"
  | "provisioning"
  | "error"
  | "unknown";

/** One virtual machine. */
export interface HostInstance {
  id: string;
  /** What the user named it, falling back to its hostname or id. */
  label: string;
  /** Drives the icon and the filter. */
  state: HostInstanceState;
  /** The vendor's own word for the state, shown in the UI detail. */
  rawState: string;
  /**
   * Public IPv4. Absent while the instance is still being provisioned, which
   * is exactly when it has no address to be reached at.
   */
  ipv4?: string;
  ipv6?: string;
  /** The instance's own hostname, when the vendor reports one. */
  hostname?: string;
  /** The vendor's region code — `ewr`, `nyc3`, `fsn1`. */
  region?: string;
  /** The vendor's plan / size id. */
  plan?: string;
  /** Operating system, as the vendor describes it. */
  os?: string;
  specs?: { vcpus?: number; memoryMb?: number; diskGb?: number };
  tags: string[];
  createdAt?: number;
  /**
   * The login the vendor created on the machine — `root` for Vultr's default
   * scheme, `linuxuser` for its unprivileged one, `ubuntu` or `ec2-user`
   * elsewhere. Neutral because every IaaS builds an image with *some* account
   * on it, and load-bearing because {@link HostProvider.toSshTarget} without it
   * produces a host that `ssh` tries to reach as the local username.
   */
  defaultUser?: string;
}

/** Which provider instance backs an SSH host, carried into the servers list. */
export interface HostInstanceRef {
  providerId: string;
  /** The provider's display name, so the row can be labelled without a lookup. */
  providerName: string;
  instanceId: string;
  state: HostInstanceState;
  rawState: string;
  region?: string;
}

/**
 * An SSH target adopted from a provider instance — a plain
 * {@link SshServerDefinition}, which is the point: everything downstream
 * (`probeSshServer`, `readRemoteHostMetrics`, the terminal route, the remote
 * service runner) already takes one and needs no knowledge of providers.
 */
export interface HostSshTarget extends SshServerDefinition {
  instance: HostInstanceRef;
}

/** The read-safe half. Nothing here starts, stops or destroys a machine. */
export interface HostProvider {
  /** Signed-in account. Reuses the deploy contract's type — an account is an account. */
  account(): Promise<ProviderAccount>;

  listInstances(): Promise<HostInstance[]>;
  getInstance(id: string): Promise<HostInstance>;

  /**
   * The instance as an SSH host, or null when there is nothing to connect to
   * yet.
   *
   * Nullable because a machine that is still provisioning genuinely has no
   * address, and the alternative — inventing a placeholder host — would put a
   * row in the servers list that can only ever fail to connect. A *stopped*
   * instance still returns a target: it keeps its address, and being able to
   * see it in the list is how the user notices it is down.
   */
  toSshTarget(instance: HostInstance): HostSshTarget | null;
}

/**
 * The write-capable half — dashboard-only, never an MCP tool.
 *
 * Split from {@link HostProvider} for the same reason `git-actions.ts` is split
 * from `git-manager.ts`: halting a production database server is not something
 * an agent holding read tools should be one call away from. §7 of the design
 * plan sketched `run?()` on the read interface; writing it that way would have
 * been the first crack in a boundary the rest of the codebase keeps.
 *
 * Named actions rather than `start()`/`stop()`/`reboot()` for the reason the
 * deploy contract gives: "halt" is Vultr's word, "power_off" is DigitalOcean's,
 * and the manifest is where a vendor's vocabulary belongs.
 */
export interface HostProviderActions {
  run(action: string, instanceId: string): Promise<void>;
}

/**
 * The declarative half — what a generic view needs to render a host provider
 * without knowing which one it is.
 */
export interface HostProviderManifest {
  id: string;
  name: string;
  kind: "host";
  /**
   * This provider's own words, per locale — the same field, the same meaning
   * and the same enforcement as a deploy provider's.
   *
   * A host provider needs it at least as much: "halt" is Vultr's word,
   * "power_off" is DigitalOcean's, and neither is a sentence a host catalogue
   * could have been written to contain. No `scope.label` here — a host
   * provider's instances are not grouped under anything the user picks between.
   */
  strings: ProviderStrings;
  /** Action names accepted by {@link HostProviderActions.run}. */
  actions: string[];
  /** The subset of `actions` that interrupts a running machine; the UI confirms these first. */
  productionAffecting: string[];
  /**
   * The egress allowlist — every host this provider may reach. Identical in
   * meaning and enforcement to a deploy provider's, and one of the few fields
   * the two contracts share, because the daemon it runs inside is the same one.
   */
  api: ProviderApiSpec;
}
