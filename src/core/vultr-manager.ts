/**
 * Read-safe Vultr API v2 client — the observable half of the integration.
 *
 * Like `git-manager.ts` and `cloudflare-manager.ts`, this module deliberately
 * contains no operation that changes a machine. Start / halt / reboot live in
 * `vultr-actions.ts`, and destructive operations (delete, reinstall, restore)
 * are not implemented at all — the same line `GitManager` draws around
 * `reset --hard`.
 *
 * Every field and path below comes from Vultr's official Go SDK
 * (`github.com/vultr/govultr`), which is generated against the same API the
 * docs describe.
 */

import type { ProviderFetch } from "./providers/egress.js";

/** Vultr's `status` — the account-level lifecycle of the machine. */
export type VultrInstanceStatus = "active" | "pending" | "suspended" | "resizing";

export interface VultrAccount {
  name: string;
  email: string;
  /** What this API key is permitted to do — `manage_users`, `subscriptions`, … */
  acls: string[];
}

export interface VultrInstance {
  id: string;
  label: string;
  hostname: string;
  status: VultrInstanceStatus;
  /** `running` / `stopped`. Empty until the instance finishes provisioning. */
  powerStatus: string;
  /** `none` / `locked` / `installingbooting` / `ok`. */
  serverStatus: string;
  /** Empty string while the instance has no address yet, normalized to undefined. */
  mainIp?: string;
  v6MainIp?: string;
  internalIp?: string;
  region: string;
  plan: string;
  os: string;
  vcpuCount: number;
  /** Vultr reports RAM in MB and disk in GB. */
  ramMb: number;
  diskGb: number;
  tags: string[];
  createdAt?: number;
  /**
   * Which login the instance was built with: `root`, or `limited` for the
   * unprivileged `linuxuser` account Vultr creates instead. This is the one
   * field that decides whether an adopted SSH target can actually connect.
   */
  userScheme: string;
}

export class VultrApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = "VultrApiError";
  }
}

/** Vultr caps `per_page` at 500; one page covers any realistic account. */
const PER_PAGE = 500;
/** A hard stop on cursor following, so a pathological account cannot hang a request. */
const MAX_PAGES = 10;

export class VultrManager {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.vultr.com/v2",
    /** The provider's scoped `fetch`; global `fetch` when built outside the registry. */
    private readonly fetchImpl?: ProviderFetch,
  ) {}

  /**
   * The account this API key belongs to.
   *
   * Vultr gives an account no id — the email is what identifies one — so that
   * is what the neutral `ProviderAccount.id` carries.
   */
  async account(): Promise<VultrAccount> {
    const { account } = await this.request<{ account: RawAccount }>("/account");
    return {
      name: account.name ?? "",
      email: account.email ?? "",
      acls: account.acls ?? [],
    };
  }

  /**
   * Every instance on the account, following Vultr's cursor pagination.
   *
   * The whole list rather than a page: the caller is building an SSH server
   * list, and a partial one would silently hide machines.
   */
  async listInstances(opts: { label?: string; tag?: string; region?: string } = {}): Promise<
    VultrInstance[]
  > {
    const instances: VultrInstance[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ per_page: String(PER_PAGE) });
      if (opts.label) query.set("label", opts.label);
      if (opts.tag) query.set("tag", opts.tag);
      if (opts.region) query.set("region", opts.region);
      if (cursor) query.set("cursor", cursor);

      const body = await this.request<RawInstanceList>(`/instances?${query.toString()}`);
      instances.push(...(body.instances ?? []).map(normalizeInstance));
      cursor = body.meta?.links?.next || undefined;
      if (!cursor) break;
    }
    return instances;
  }

  async getInstance(id: string): Promise<VultrInstance> {
    const { instance } = await this.request<{ instance: RawInstance }>(
      `/instances/${encodeURIComponent(id)}`,
    );
    return normalizeInstance(instance);
  }

  private request<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
    return vultrRequest<T>(
      { token: this.token, baseUrl: this.baseUrl, fetch: this.fetchImpl },
      path,
      opts,
    );
  }
}

export interface VultrRequestAuth {
  token: string;
  baseUrl?: string;
  /**
   * The provider's scoped `fetch` (see `providers/egress.ts`). Absent means
   * global `fetch` — the case for a manager built directly in a test. Production
   * clients come from `vultr-context.ts`, which always supplies one.
   */
  fetch?: ProviderFetch;
}

/**
 * The one place a Vultr API call is made. Shared with `vultr-actions.ts` so
 * auth and error shaping stay identical across the read and write halves — the
 * read/write boundary is which module exposes an operation, not which one can
 * reach the network.
 */
export async function vultrRequest<T>(
  auth: VultrRequestAuth,
  path: string,
  opts?: { method?: string; body?: unknown },
): Promise<T> {
  const url = path.startsWith("http") ? path : `${auth.baseUrl ?? "https://api.vultr.com/v2"}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json",
  };
  const init: RequestInit = { method: opts?.method ?? "GET", headers };
  if (opts?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }

  const response = await (auth.fetch ?? fetch)(url, init);
  // Power actions answer 204 with no body, so the body is only read when there
  // is one to read.
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const failure = safeParse(text) as { error?: string } | undefined;
    throw new VultrApiError(
      failure?.error || `Vultr returned ${response.status} for ${path}`,
      response.status,
      path,
    );
  }
  return (safeParse(text) ?? {}) as T;
}

function safeParse(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface RawAccount {
  name?: string;
  email?: string;
  acls?: string[];
}

interface RawInstanceList {
  instances?: RawInstance[];
  meta?: { total?: number; links?: { next?: string; prev?: string } | null } | null;
}

interface RawInstance {
  id: string;
  label?: string;
  hostname?: string;
  status?: string;
  power_status?: string;
  server_status?: string;
  main_ip?: string;
  v6_main_ip?: string;
  internal_ip?: string;
  region?: string;
  plan?: string;
  os?: string;
  vcpu_count?: number;
  ram?: number;
  disk?: number;
  tags?: string[];
  date_created?: string;
  user_scheme?: string;
}

/**
 * Vultr writes "no address" as the empty string rather than omitting the field,
 * and `0.0.0.0` while an instance is still being built. Both mean the same
 * thing to a caller trying to reach the machine.
 */
function address(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "0.0.0.0" || trimmed === "::") return undefined;
  return trimmed;
}

function normalizeInstance(instance: RawInstance): VultrInstance {
  const createdAt = Date.parse(instance.date_created ?? "");
  return {
    id: instance.id,
    label: instance.label ?? "",
    hostname: instance.hostname ?? "",
    status: (instance.status as VultrInstanceStatus) ?? "pending",
    powerStatus: instance.power_status ?? "",
    serverStatus: instance.server_status ?? "",
    mainIp: address(instance.main_ip),
    v6MainIp: address(instance.v6_main_ip),
    internalIp: address(instance.internal_ip),
    region: instance.region ?? "",
    plan: instance.plan ?? "",
    os: instance.os ?? "",
    vcpuCount: instance.vcpu_count ?? 0,
    ramMb: instance.ram ?? 0,
    diskGb: instance.disk ?? 0,
    tags: instance.tags ?? [],
    createdAt: Number.isNaN(createdAt) ? undefined : createdAt,
    userScheme: instance.user_scheme ?? "root",
  };
}
