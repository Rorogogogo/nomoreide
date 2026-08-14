/**
 * Deploy-provider API surface — the single contract both backends implement.
 * See {@link ../git-api} for the shared-interface seam rationale.
 *
 * Every call takes a provider id first. One set of functions serves every
 * provider, so adding Cloudflare adds nothing here.
 *
 * The read/write split from the server survives: `listX`/`getX` map onto the
 * read-safe `DeployProvider`, while `runDeploymentAction` maps onto the one
 * guarded route that fronts `DeployProviderActions`.
 */

export type ProviderDeploymentState =
  | "queued"
  | "building"
  | "ready"
  | "error"
  | "canceled"
  | "blocked"
  | "deleted";

export type DeployCapability =
  | "projects"
  | "deployments"
  | "buildLogs"
  | "runtimeLogs"
  | "env"
  | "domains";

/**
 * One locale's worth of a provider's strings, keyed `scope.label` /
 * `action.<name>` / `action.<name>.done` / `action.<name>.confirm[Title]`.
 */
export type ProviderStringBundle = Record<string, string>;

/**
 * A manifest's strings. `en` is required and every other locale optional, so a
 * plugin author can ship English only and lookup falls back rather than fails.
 * In-tree providers must be complete in every locale — enforced by
 * `test/provider-strings.test.ts`, not by this type.
 */
export interface ProviderStrings {
  en: ProviderStringBundle;
  zh?: ProviderStringBundle;
}

/** The declarative half of a provider — what the generic view renders from. */
export interface ProviderManifest {
  id: string;
  name: string;
  kind: "deploy";
  /**
   * The provider's own words, per locale — action labels, their toasts and
   * confirmations, and `scope.label` ("Team" for Vercel, "Account" for
   * Cloudflare). Mirrors `core/providers/strings.ts`; resolved through
   * `useProviderString` rather than `useT`, because the host's catalogue cannot
   * hold keys named after a vendor's vocabulary.
   */
  strings: ProviderStrings;
  /** Which connect paths the setup screen may offer. Cloudflare has no `oauth`. */
  authSources: ("cli" | "stored" | "oauth")[];
  capabilities: DeployCapability[];
  actions: string[];
  /** The subset of `actions` the UI confirms before running. */
  productionAffecting: string[];
}

/**
 * One build setting. `value: null` means "not overridden" — the provider uses
 * the framework's own default. A setting *missing from the array* means the
 * list endpoint did not return it, which is a different thing.
 */
export interface ProviderSetting {
  key: string;
  label: string;
  value: string | null;
}

export interface ProviderProject {
  id: string;
  name: string;
  framework?: string | null;
  updatedAt?: number;
  link?: {
    type: string;
    org?: string;
    repo?: string;
    productionBranch?: string;
  };
  settings: ProviderSetting[];
}

/** An environment variable, listed without its value. See `getEnvValue`. */
export interface ProviderEnvVar {
  id: string;
  key: string;
  environments: string[];
  type: string;
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

export interface ProviderDomain {
  name: string;
  apexName?: string;
  verified: boolean;
  redirect?: string | null;
  gitBranch?: string | null;
  createdAt?: number;
  updatedAt?: number;
  verification: ProviderDomainVerification[];
}

/** Build and runtime output share a shape; `kind` says which this is. */
export interface ProviderLogLine {
  id: string;
  createdAt: number;
  kind: "build" | "runtime";
  /** `stdout`/`stderr` for build lines, `error`/`warning`/`info` for runtime. */
  level: string;
  text: string;
  source?: string;
  request?: { method?: string; path?: string; statusCode?: number };
}

export interface ProviderScope {
  id: string;
  slug: string;
  name: string | null;
}

export interface ProviderDeployment {
  id: string;
  name: string;
  url: string | null;
  state: ProviderDeploymentState;
  /** The vendor's own word for the state, shown in the detail panel. */
  rawState: string;
  /** `production` / `staging`; null is a preview deployment. */
  target: string | null;
  createdAt: number;
  readyAt?: number;
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

export type ProviderConnectionStatus =
  | "checking"
  | "not_configured"
  | "connected"
  /** Connected, but no project resolves for this repository. */
  | "no_project"
  | "auth_error"
  | "connection_error";

export interface ProviderConnection {
  /** `oauth` is the browser sign-in; see `core/providers/oauth.ts`. */
  source: "cli" | "stored" | "oauth";
  scopeId?: string;
  scopeSlug?: string;
  username?: string;
}

export interface ProviderStatusInfo {
  status: Exclude<ProviderConnectionStatus, "checking">;
  provider?: ProviderManifest;
  connection?: ProviderConnection;
  /** True when the vendor CLI has a login we can borrow. */
  cliAvailable: boolean;
  cliError?: string;
  error?: string;
  user?: { username: string; avatar?: string };
  scopes?: ProviderScope[];
  project?: ProviderProject;
  scopeId?: string;
  repositoryName?: string;
}

/** Where a browser sign-in has got to, polled while the consent tab is open. */
export type ProviderOAuthPhase =
  | { phase: "idle" | "pending" | "connected" }
  | { phase: "error"; error: string };

export interface ProviderApi {
  listProviders(): Promise<ProviderManifest[]>;
  getStatus(providerId: string): Promise<ProviderStatusInfo>;
  connect(
    providerId: string,
    input: { source: "cli" } | { source: "stored"; token: string },
  ): Promise<void>;
  /** Begins a browser sign-in; returns the URL the user must open. */
  startOAuth(providerId: string): Promise<{ url: string }>;
  getOAuthPhase(providerId: string): Promise<ProviderOAuthPhase>;
  disconnect(providerId: string): Promise<void>;
  setScope(providerId: string, scope: { scopeId?: string; scopeSlug?: string }): Promise<void>;
  listProjects(
    providerId: string,
    search?: string,
  ): Promise<{ projects: ProviderProject[]; linkedProjectId?: string }>;
  /** Pin the selected repo's project; pass undefined to clear the pin. */
  setProject(providerId: string, projectId: string | undefined): Promise<void>;
  /** The linked project read in full, including its build settings. */
  getProject(providerId: string): Promise<ProviderProject>;
  listEnv(providerId: string): Promise<ProviderEnvVar[]>;
  /** Reveals one variable's value — an explicit, human-driven read. */
  getEnvValue(providerId: string, id: string): Promise<string>;
  createEnv(
    providerId: string,
    input: {
      key: string;
      value: string;
      environments: string[];
      type?: "encrypted" | "plain";
    },
  ): Promise<ProviderEnvVar>;
  /** The key is not editable — a rename is a delete-and-recreate. */
  updateEnv(
    providerId: string,
    id: string,
    input: { value?: string; environments?: string[] },
  ): Promise<ProviderEnvVar>;
  deleteEnv(providerId: string, id: string): Promise<void>;
  listDomains(providerId: string): Promise<ProviderDomain[]>;
  listDeployments(
    providerId: string,
    opts?: { target?: "production" | "preview"; limit?: number },
  ): Promise<{ deployments: ProviderDeployment[]; project: ProviderProject | null }>;
  getDeployment(providerId: string, id: string): Promise<ProviderDeploymentDetail>;
  getDeploymentLogs(providerId: string, id: string, limit?: number): Promise<ProviderLogLine[]>;
  /** Empty when the provider or the account's plan does not serve runtime logs. */
  getRuntimeLogs(providerId: string, id: string, limit?: number): Promise<ProviderLogLine[]>;
  /** `action` must be one of the provider manifest's `actions`. */
  runDeploymentAction(
    providerId: string,
    id: string,
    action: string,
  ): Promise<{ deployment?: { id: string; url: string | null } }>;
}
