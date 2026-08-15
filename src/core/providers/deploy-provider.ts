/**
 * The contract a deploy platform implements — Vercel today, Cloudflare and
 * Netlify next.
 *
 * Every method here already existed on `VercelManager` with the same arguments;
 * this is a rename plus four deliberate neutralizations, each of which is a
 * place the abstraction would otherwise leak on provider #2:
 *
 * 1. **Build settings are a list, not fields.** `VercelProject` hard-codes
 *    seven; Cloudflare's set differs and an IaaS provider has none.
 * 2. **Deployment state carries `rawState`.** The vendor's own word survives
 *    normalization, so the first provider whose states don't map cleanly does
 *    not force a contract change.
 * 3. **Build and runtime log lines are one type.** They answer different
 *    questions but have the same shape, and a provider may serve only one.
 * 4. **Writes are a named action list, not fixed methods.** See
 *    {@link DeployProviderActions}.
 *
 * The read-safe / write-capable split from `git-manager`/`git-actions` and
 * `db-peek`/`db-write` is preserved exactly: {@link DeployProvider} contains
 * nothing that changes what is deployed, and {@link DeployProviderActions} is a
 * separate object resolved separately and never exposed as an MCP tool.
 */

import type { ProviderApiSpec } from "./egress.js";
import type { ProviderStrings } from "./strings.js";

/** Signed-in account. ← `VercelViewer` */
export interface ProviderAccount {
  id: string;
  username: string;
  name?: string | null;
  email?: string | null;
  avatar?: string | null;
}

/** A team / org / account within the provider. ← `VercelTeam` */
export interface ProviderScope {
  id: string;
  slug: string;
  name: string | null;
}

/** A project's Git connection, when it was imported from a repository. */
export interface ProviderProjectLink {
  type: string;
  org?: string;
  repo?: string;
  productionBranch?: string;
}

/**
 * One build setting.
 *
 * `value: null` means "not overridden" — the provider is using the framework's
 * own default — which is a meaningful state and distinct from the setting being
 * *absent from the array*, which means "not read". Vercel's list endpoint omits
 * settings that its single-project endpoint fills in, and the settings panel
 * relies on telling those two apart.
 */
export interface ProviderSetting {
  key: string;
  label: string;
  value: string | null;
}

/** ← `VercelProject` */
export interface ProviderProject {
  id: string;
  name: string;
  framework?: string | null;
  updatedAt?: number;
  link?: ProviderProjectLink;
  settings: ProviderSetting[];
}

/**
 * Normalized deployment state, chosen to be the intersection that drives an
 * icon and a filter. Anything finer belongs in `rawState`.
 */
export type ProviderDeploymentState =
  | "queued"
  | "building"
  | "ready"
  | "error"
  | "canceled"
  | "blocked"
  | "deleted";

/** ← `VercelDeployment` */
export interface ProviderDeployment {
  id: string;
  name: string;
  /**
   * The deployment's hostname, **without a scheme** — consumers prefix
   * `https://`. Vercel returns it this way; Cloudflare returns a full URL and
   * its adapter strips the scheme.
   */
  url: string | null;
  /** Drives the icon and the filter. */
  state: ProviderDeploymentState;
  /** The vendor's own word for the state, shown in the UI detail. */
  rawState: string;
  /** `production` / `staging`; null is a preview deployment. */
  target: string | null;
  createdAt: number;
  readyAt?: number;
  /** True while this deployment serves the project's production alias. */
  isCurrentProduction?: boolean;
  creator?: { username?: string; email?: string };
  meta: {
    branch?: string;
    sha?: string;
    commitMessage?: string;
    commitAuthor?: string;
  };
  inspectorUrl?: string;
}

export interface ProviderDeploymentDetail extends ProviderDeployment {
  aliases: string[];
  buildingAt?: number;
  errorMessage?: string;
}

/**
 * A line of build or runtime output. ← `VercelBuildLogLine` + `VercelRuntimeLogLine`
 *
 * Merged because the two differ only in what `level` holds and whether a
 * request is attached, and a provider may serve one without the other.
 */
export interface ProviderLogLine {
  id: string;
  createdAt: number;
  kind: "build" | "runtime";
  /** `stdout` / `stderr` / `command` for build lines; `error` / `warning` / `info` for runtime. */
  level: string;
  text: string;
  source?: string;
  /** Runtime lines only — which request produced this line. */
  request?: { method?: string; path?: string; statusCode?: number };
}

/**
 * A project environment variable, with its value deliberately absent.
 *
 * Listing answers "is this key set, and where" — the question a failed deploy
 * actually raises. The value is a separate, explicitly-requested read (see
 * {@link DeployProvider.getEnvValue}), so merely opening the tab never puts a
 * secret on the wire. ← `VercelEnvVar`
 */
export interface ProviderEnvVar {
  id: string;
  key: string;
  /** `production` / `preview` / `development`. ← Vercel's `target` */
  environments: string[];
  /** `encrypted` / `plain` / `system` / `secret`. */
  type: string;
  /** Set when the variable is scoped to one preview branch. */
  gitBranch?: string | null;
  comment?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface ProviderDomainVerification {
  type: string;
  domain: string;
  value: string;
  reason?: string;
}

/** ← `VercelDomain` */
export interface ProviderDomain {
  name: string;
  apexName?: string;
  verified: boolean;
  /** Set when the domain is a redirect rather than a served alias. */
  redirect?: string | null;
  gitBranch?: string | null;
  createdAt?: number;
  updatedAt?: number;
  /** Outstanding DNS records the user must add, when unverified. */
  verification: ProviderDomainVerification[];
}

/**
 * Optional reads. Declared in the manifest's `capabilities` so the generic view
 * can hide a tab rather than render one that errors.
 */
export type DeployCapability =
  | "projects"
  | "deployments"
  | "buildLogs"
  | "runtimeLogs"
  | "env"
  | "domains";

/** The read-safe half. Nothing here changes what is deployed. */
export interface DeployProvider {
  account(): Promise<ProviderAccount>;
  listScopes(): Promise<ProviderScope[]>;

  listProjects(opts?: {
    search?: string;
    repoUrl?: string;
    limit?: number;
  }): Promise<ProviderProject[]>;
  getProject(id: string): Promise<ProviderProject>;

  listDeployments(opts: {
    projectId: string;
    target?: "production" | "preview";
    limit?: number;
  }): Promise<ProviderDeployment[]>;
  getDeployment(id: string): Promise<ProviderDeploymentDetail>;
  buildLogs(id: string, limit?: number): Promise<ProviderLogLine[]>;

  // --- capability-gated; absent when the provider does not support them ---

  /** Returns [] when the account's plan lacks them, rather than throwing. */
  runtimeLogs?(id: string, limit?: number): Promise<ProviderLogLine[]>;
  /** Values deliberately absent — see {@link ProviderEnvVar}. */
  listEnv?(projectId: string): Promise<ProviderEnvVar[]>;
  /** The one door for reading a secret. */
  getEnvValue?(projectId: string, envId: string): Promise<string>;
  listDomains?(projectId: string): Promise<ProviderDomain[]>;
}

export interface DeployActionInput {
  deploymentId: string;
  /** Required by actions that address the project rather than the deployment. */
  projectId?: string;
  /**
   * The deployment's own name and environment, read before the call and passed
   * through by actions that recreate it. Vercel's redeploy needs both, or a
   * production retry silently comes back as a preview.
   */
  name?: string;
  target?: string | null;
  /** Recorded by providers that accept a reason (Vercel's rollback). */
  description?: string;
}

export interface DeployActionResult {
  /** Set when the action created a new deployment, as `redeploy` does. */
  deployment?: { id: string; url: string | null };
}

/**
 * The write-capable half — dashboard-only, never an MCP tool.
 *
 * **Why `run(action, …)` rather than `redeploy()`/`cancel()`/`promote()`/
 * `rollback()`:** promote-vs-rollback is Vercel-specific vocabulary (Vercel
 * records a rollback, with its reason, on a different endpoint from a forward
 * promotion). Cloudflare has "retry" and "rollback" but no "promote"; Netlify
 * has "publish". Fixing four method names into the contract would bake in one
 * vendor's words. The names a provider actually offers, and which of them
 * change what production serves, are declared in its manifest instead.
 */
export interface DeployProviderActions {
  run(action: string, input: DeployActionInput): Promise<DeployActionResult>;

  createEnv?(
    projectId: string,
    input: { key: string; value: string; environments: string[]; type?: "encrypted" | "plain" },
  ): Promise<ProviderEnvVar>;
  updateEnv?(
    projectId: string,
    envId: string,
    input: { value?: string; environments?: string[] },
  ): Promise<ProviderEnvVar>;
  deleteEnv?(projectId: string, envId: string): Promise<void>;
}

/**
 * The vendor-specific inputs to project resolution — the only two things in
 * that three-tier ladder that are not generic.
 */
export interface DeployProviderHooks {
  /** Normalizes a git remote into the URL the vendor keys projects by. */
  repoUrl(remoteUrl: string): string | null;
  /**
   * The file the vendor's CLI writes on `link`. Vercel:
   * `{ path: ".vercel/project.json", field: "projectId" }`. Providers without
   * one simply skip that tier.
   */
  linkFile?: { path: string; field: string };
}

/**
 * The declarative half of a provider — everything a generic view needs in
 * order to render it without knowing which provider it is.
 *
 * Plain data because this is what a provider manifest carries. `strings` and
 * `auth` join it when the registry lands; today it holds what already exists.
 */
export interface DeployProviderManifest {
  id: string;
  name: string;
  kind: "deploy";
  /**
   * This provider's own words, per locale — its action labels, their toasts and
   * confirmations, and what it calls a scope (`scope.label`: "Team" for Vercel,
   * "Account" for Cloudflare).
   *
   * Here rather than in the host's `i18n/en.ts` because the provider, not the
   * host, determines which keys exist: `actions` is a free list of vendor
   * vocabulary, so the host cannot hold a catalogue entry for a word it has
   * never seen. See `providers/strings.ts`.
   */
  strings: ProviderStrings;
  /**
   * How this provider can be connected.
   *
   * The generic setup screen cannot otherwise know whether to offer "sign in
   * with browser": Vercel has all three sources, while Cloudflare has no
   * registration endpoint for `providers/oauth.ts` to mint a client against, so
   * offering it there is a button that can only fail. This is a fact about each
   * provider's *current* wiring rather than a permanent one — see
   * `cloudflare-auth.ts` — which is exactly why it is declared per provider
   * instead of inferred. Kept in step with the `ProviderAuthSpec` by
   * `test/provider-routes.test.ts`.
   */
  authSources: ("cli" | "stored" | "oauth")[];
  capabilities: DeployCapability[];
  /**
   * Whether a scope must be chosen before anything can be read at all.
   *
   * Cloudflare addresses every Pages URL as `/accounts/<id>/…`, so without an
   * account id there is no request to make; Vercel's personal scope is a real
   * resting state, so "no scope" is normal there. The switcher needs the
   * difference because a scope list can come back empty for a perfectly good
   * token — enumerating Cloudflare accounts needs `Account Settings: Read`,
   * which a Pages token has no reason to carry — and the two providers want
   * opposite things in that case: Vercel, nothing; Cloudflare, a way to enter
   * the id by hand rather than a dead end.
   */
  requiresScope?: boolean;
  /** Action names accepted by {@link DeployProviderActions.run}. */
  actions: string[];
  /** The subset of `actions` that changes what production serves; the UI confirms these first. */
  productionAffecting: string[];
  /**
   * The egress allowlist — every host this provider may reach.
   *
   * Enforced, not documented: the provider's registry entry mints its client
   * with `createProviderFetch(manifest)`, and a request to any other host throws
   * before it is sent. See `providers/egress.ts`.
   */
  api: ProviderApiSpec;
}
