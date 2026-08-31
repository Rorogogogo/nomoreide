import type {
  HostInstance,
  HostInstanceState,
  HostProvider,
  HostProviderActions,
  HostProviderManifest,
  HostSshTarget,
} from "./providers/host-provider.js";
import {
  PRODUCTION_AFFECTING_ACTIONS,
  VULTR_ACTIONS,
  type VultrActions,
} from "./vultr-actions.js";
import { VULTR_PROVIDER_ID } from "./vultr-auth.js";
import { providerApiHost } from "./providers/api-base.js";
import { vultrApiBase, type VultrInstance, type VultrManager } from "./vultr-manager.js";

/**
 * Vultr as `HostProvider` implementation #1 — the provider that tests whether
 * the *second* contract was shaped by the problem or by the first one.
 *
 * A pure adapter, like `vercel-provider.ts` and `cloudflare-provider.ts`: every
 * method delegates to `VultrManager` or `VultrActions` and only reshapes the
 * result.
 *
 * What writing it surfaced:
 *
 * 1. **A host provider is not repo-scoped.** `DeployProvider` needs a working
 *    directory to answer anything, because a deployment belongs to the project
 *    a repository is linked to. An instance belongs to an account. So there is
 *    no project-resolution ladder here, no link file, no `repoUrl` hook — the
 *    whole of `providers/project-resolution.ts` is simply not part of this
 *    contract, which is why the split into two contracts was right.
 * 2. **`toSshTarget` needs the machine's login, not just its address.** Hence
 *    `HostInstance.defaultUser`: Vultr builds an instance with either `root` or
 *    an unprivileged `linuxuser`, and a target that omits it is one `ssh` tries
 *    as the *local* username, which fails for every Vultr instance.
 * 3. **The shared credential layer carried over untouched.** Vultr reuses
 *    `providers/credentials.ts` exactly, despite being neither a deploy
 *    platform nor an OAuth one — the first evidence that layer generalized
 *    beyond the contract it was extracted from.
 */

export const VULTR_MANIFEST: HostProviderManifest = {
  id: VULTR_PROVIDER_ID,
  name: "Vultr",
  kind: "host",
  // Three action names that share not one word with either deploy provider,
  // which is the clearest evidence for why these strings belong to the plugin:
  // no host catalogue written for Vercel could ever have contained "halt".
  // No `scope.label` — a host provider has no scopes.
  strings: {
    en: {
      "action.start": "Start",
      "action.start.done": "Instance starting.",
      "action.halt": "Stop",
      "action.halt.done": "Instance stopping.",
      "action.halt.confirmTitle": "Stop this instance?",
      "action.halt.confirm":
        "The machine powers off immediately. Anything running on it stops.",
      "action.reboot": "Reboot",
      "action.reboot.done": "Instance rebooting.",
      "action.reboot.confirmTitle": "Reboot this instance?",
      "action.reboot.confirm":
        "The machine restarts immediately. Anything running on it stops.",
    },
    zh: {
      "action.start": "启动",
      "action.start.done": "实例正在启动。",
      "action.halt": "停止",
      "action.halt.done": "实例正在停止。",
      "action.halt.confirmTitle": "停止该实例？",
      "action.halt.confirm": "机器将立即关机，其上运行的一切都会停止。",
      "action.reboot": "重启",
      "action.reboot.done": "实例正在重启。",
      "action.reboot.confirmTitle": "重启该实例？",
      "action.reboot.confirm": "机器将立即重启，其上运行的一切都会停止。",
    },
  },
  actions: [...VULTR_ACTIONS],
  productionAffecting: [...PRODUCTION_AFFECTING_ACTIONS],
  // The API only. An adopted instance is reached over SSH by `ssh-servers.ts`,
  // which is the host's own transport and never goes through this fetch — so no
  // instance address belongs here.
  api: { hosts: [providerApiHost(vultrApiBase())] },
};

/**
 * Vultr's three-field state onto the five neutral ones.
 *
 * Vultr describes a machine with `status` (the subscription's lifecycle),
 * `power_status` (whether the VM is switched on) and `server_status` (how far
 * the OS install has got). Only their combination says whether the machine can
 * be reached: an `active` instance that is `running` is still unreachable while
 * `server_status` is `installingbooting`.
 *
 * `suspended` has no neutral equivalent — it is Vultr locking the machine, and
 * the user has to go and deal with it — so it maps to `error` and survives
 * verbatim in `rawState`, the same pressure valve `skipped` used on Cloudflare.
 */
export function toInstanceState(instance: VultrInstance): HostInstanceState {
  switch (instance.status) {
    case "pending":
    case "resizing":
      return "provisioning";
    case "suspended":
      return "error";
    case "active":
      break;
    default:
      return "unknown";
  }
  if (instance.serverStatus === "installingbooting") return "provisioning";
  if (instance.serverStatus === "locked") return "provisioning";
  if (instance.powerStatus === "running") return "running";
  if (instance.powerStatus === "stopped") return "stopped";
  return "unknown";
}

/**
 * The word Vultr's own dashboard shows, so `rawState` reads as something the
 * user recognizes rather than as a field dump: the lifecycle status while the
 * instance is not yet `active`, then the install stage, then the power state.
 */
export function toRawState(instance: VultrInstance): string {
  if (instance.status !== "active") return instance.status;
  if (instance.serverStatus === "installingbooting") return "installing";
  if (instance.serverStatus === "locked") return "locked";
  return instance.powerStatus || "unknown";
}

/**
 * Vultr's `user_scheme` onto the account name actually present on the machine.
 * `limited` provisions a sudo-capable `linuxuser` instead of enabling `root`.
 */
export function toDefaultUser(instance: VultrInstance): string {
  return instance.userScheme === "limited" ? "linuxuser" : "root";
}

export function toHostInstance(instance: VultrInstance): HostInstance {
  return {
    id: instance.id,
    // A Vultr instance may be created with no label at all, in which case its
    // hostname is the only human-readable thing about it.
    label: instance.label || instance.hostname || instance.id,
    state: toInstanceState(instance),
    rawState: toRawState(instance),
    ipv4: instance.mainIp,
    ipv6: instance.v6MainIp,
    hostname: instance.hostname || undefined,
    region: instance.region || undefined,
    plan: instance.plan || undefined,
    os: instance.os || undefined,
    specs: {
      vcpus: instance.vcpuCount || undefined,
      memoryMb: instance.ramMb || undefined,
      diskGb: instance.diskGb || undefined,
    },
    tags: instance.tags,
    createdAt: instance.createdAt,
    defaultUser: toDefaultUser(instance),
  };
}

/**
 * The instance as an SSH host — the payoff this contract exists for.
 *
 * Exported and pure so the mapping is testable on its own, and shared by the
 * provider below.
 */
export function toVultrSshTarget(instance: HostInstance): HostSshTarget | null {
  // IPv4 first: a v6-only target only works from a v6-capable client, and an
  // instance without either address is still being built.
  const address = instance.ipv4 ?? instance.ipv6;
  if (!address) return null;
  return {
    host: instance.defaultUser ? `${instance.defaultUser}@${address}` : address,
    name: instance.label,
    // `environment` is deliberately left unset. Vultr tags are free-form and
    // mean whatever the account owner decided, so inferring "Production" from
    // one would eventually put that label on the wrong machine. A user-saved
    // value wins in the merge anyway, so this is a blank the user can fill.
    instance: {
      providerId: VULTR_PROVIDER_ID,
      providerName: VULTR_MANIFEST.name,
      instanceId: instance.id,
      state: instance.state,
      rawState: instance.rawState,
      region: instance.region,
    },
  };
}

/** The read-safe half, over an already-authenticated `VultrManager`. */
export function createVultrHostProvider(manager: VultrManager): HostProvider {
  return {
    async account() {
      const account = await manager.account();
      return {
        // Vultr gives an account no id of its own; the email is what identifies
        // one, and is what its dashboard shows.
        id: account.email,
        username: account.email,
        name: account.name || null,
        email: account.email || null,
      };
    },
    async listInstances() {
      return (await manager.listInstances()).map(toHostInstance);
    },
    async getInstance(id) {
      return toHostInstance(await manager.getInstance(id));
    },
    toSshTarget: toVultrSshTarget,
  };
}

/**
 * The write-capable half. Kept a separate factory, resolved separately, and
 * never handed to an MCP tool — the same boundary `VultrActions` has.
 */
export function createVultrHostActions(actions: VultrActions): HostProviderActions {
  return {
    async run(action: string, instanceId: string): Promise<void> {
      switch (action) {
        case "start":
          await actions.start(instanceId);
          return;
        case "halt":
          await actions.halt(instanceId);
          return;
        case "reboot":
          await actions.reboot(instanceId);
          return;
        default:
          throw new Error(`Vultr does not support the action "${action}".`);
      }
    },
  };
}
