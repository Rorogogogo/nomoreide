import { vultrRequest, type VultrRequestAuth } from "./vultr-manager.js";

/**
 * Write-capable Vultr power operations, deliberately separate from the
 * read-safe {@link ./vultr-manager.js VultrManager} — the same split as
 * `git-manager` / `git-actions`, `db-peek` / `db-write` and
 * `cloudflare-manager` / `cloudflare-actions`.
 *
 * Everything here interrupts a machine someone may be depending on, so none of
 * it is exposed as an MCP tool: these are reached only from the dashboard's own
 * routes, where a human clicked the button.
 *
 * Deliberately excludes the irreversible ones. Vultr's `DELETE /instances/{id}`
 * destroys the machine and its disk, and `POST /instances/{id}/reinstall`
 * wipes it — neither belongs behind the same button as "reboot", and neither is
 * implemented here at all.
 */

/**
 * The actions this provider offers, in Vultr's own vocabulary.
 *
 * "halt" rather than "stop" because that is what Vultr's endpoint is called and
 * what its dashboard says; the manifest is where a vendor's words are allowed
 * to live, which is the whole reason {@link
 * import("./providers/host-provider.js").HostProviderActions.run} takes a name
 * rather than fixing methods into the contract.
 */
export const VULTR_ACTIONS = ["start", "halt", "reboot"] as const;
export type VultrActionName = (typeof VULTR_ACTIONS)[number];

/**
 * The ones that interrupt a running machine, so the UI confirms before sending
 * them. `start` is not one: the worst it does to a stopped instance is start it.
 */
export const PRODUCTION_AFFECTING_ACTIONS: readonly VultrActionName[] = ["halt", "reboot"];

export class VultrActions {
  constructor(private readonly auth: VultrRequestAuth) {}

  /** Power a stopped instance back on. */
  start(instanceId: string): Promise<void> {
    return this.power(instanceId, "start");
  }

  /**
   * Power an instance off.
   *
   * Vultr's "halt" is a hard power-off, not a graceful shutdown — the guest OS
   * is not asked first. That is why it counts as production-affecting.
   */
  halt(instanceId: string): Promise<void> {
    return this.power(instanceId, "halt");
  }

  /** Hard-restart an instance. */
  reboot(instanceId: string): Promise<void> {
    return this.power(instanceId, "reboot");
  }

  /**
   * The three power endpoints are identical apart from their last path segment,
   * and all three answer 204 with no body.
   */
  private async power(instanceId: string, action: VultrActionName): Promise<void> {
    await vultrRequest<void>(
      this.auth,
      `/instances/${encodeURIComponent(instanceId)}/${action}`,
      { method: "POST" },
    );
  }
}
