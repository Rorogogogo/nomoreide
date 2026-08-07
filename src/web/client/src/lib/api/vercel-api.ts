/**
 * Vercel API surface — the single contract both backends implement. See
 * {@link ../git-api} for the shared-interface seam rationale.
 *
 * The read/write split from the server survives here: `listX`/`getX` map onto
 * the read-safe `VercelManager`, while the four action calls map onto the one
 * guarded route that fronts `VercelActions`.
 */

export type VercelDeploymentState =
  | "BUILDING"
  | "ERROR"
  | "INITIALIZING"
  | "QUEUED"
  | "READY"
  | "CANCELED"
  | "BLOCKED"
  | "DELETED";

export interface VercelProject {
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
  /** Null means "not overridden" — Vercel uses the framework's own default. */
  buildCommand?: string | null;
  devCommand?: string | null;
  installCommand?: string | null;
  outputDirectory?: string | null;
  rootDirectory?: string | null;
  nodeVersion?: string | null;
  serverlessFunctionRegion?: string | null;
}

/** An environment variable, listed without its value. See `getVercelEnvValue`. */
export interface VercelEnvVar {
  id: string;
  key: string;
  target: string[];
  type: string;
  gitBranch?: string | null;
  comment?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface VercelDomainVerification {
  type: string;
  domain: string;
  value: string;
  reason?: string;
}

export interface VercelDomain {
  name: string;
  apexName?: string;
  verified: boolean;
  redirect?: string | null;
  gitBranch?: string | null;
  createdAt?: number;
  updatedAt?: number;
  verification: VercelDomainVerification[];
}

export interface VercelRuntimeLogLine {
  id: string;
  createdAt: number;
  level: string;
  message: string;
  source?: string;
  statusCode?: number;
  requestMethod?: string;
  requestPath?: string;
}

export interface VercelTeam {
  id: string;
  slug: string;
  name: string | null;
}

export interface VercelDeployment {
  uid: string;
  name: string;
  url: string | null;
  state: VercelDeploymentState;
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

export interface VercelDeploymentDetail extends VercelDeployment {
  aliases: string[];
  buildingAt?: number;
  errorMessage?: string;
}

export interface VercelBuildLogLine {
  id: string;
  createdAt: number;
  type: string;
  text: string;
}

export type VercelConnectionStatus =
  | "checking"
  | "not_configured"
  | "connected"
  /** Connected, but no Vercel project resolves for this repository. */
  | "no_project"
  | "auth_error"
  | "connection_error";

export interface VercelConnection {
  /** `oauth` is the browser sign-in; see `core/vercel-oauth.ts`. */
  source: "cli" | "stored" | "oauth";
  teamId?: string;
  teamSlug?: string;
  username?: string;
}

export interface VercelStatusInfo {
  status: Exclude<VercelConnectionStatus, "checking">;
  connection?: VercelConnection;
  /** True when the Vercel CLI has a login we can borrow. */
  cliAvailable: boolean;
  cliError?: string;
  error?: string;
  user?: { username: string; avatar?: string };
  teams?: VercelTeam[];
  project?: VercelProject;
  teamId?: string;
  repositoryName?: string;
}

export type VercelDeploymentAction = "redeploy" | "cancel" | "promote" | "rollback";

/** Where a browser sign-in has got to, polled while the consent tab is open. */
export type VercelOAuthPhase =
  | { phase: "idle" | "pending" | "connected" }
  | { phase: "error"; error: string };

export interface VercelApi {
  getVercelStatus(): Promise<VercelStatusInfo>;
  connectVercel(input: { source: "cli" } | { source: "stored"; token: string }): Promise<void>;
  /** Begins a browser sign-in; returns the Vercel URL the user must open. */
  startVercelOAuth(): Promise<{ url: string }>;
  getVercelOAuthPhase(): Promise<VercelOAuthPhase>;
  disconnectVercel(): Promise<void>;
  setVercelScope(scope: { teamId?: string; teamSlug?: string }): Promise<void>;
  listVercelProjects(search?: string): Promise<{
    projects: VercelProject[];
    linkedProjectId?: string;
  }>;
  /** Pin the selected repo's project; pass undefined to clear the pin. */
  setVercelProject(projectId: string | undefined): Promise<void>;
  /** The linked project read in full, including its build settings. */
  getVercelProject(): Promise<VercelProject>;
  listVercelEnv(): Promise<VercelEnvVar[]>;
  /** Reveals one variable's value — an explicit, human-driven read. */
  getVercelEnvValue(id: string): Promise<string>;
  listVercelDomains(): Promise<VercelDomain[]>;
  listVercelDeployments(opts?: {
    target?: "production" | "preview";
    limit?: number;
  }): Promise<{ deployments: VercelDeployment[]; project: VercelProject | null }>;
  getVercelDeployment(id: string): Promise<VercelDeploymentDetail>;
  getVercelDeploymentLogs(id: string, limit?: number): Promise<VercelBuildLogLine[]>;
  /** Empty when the account's plan does not serve runtime logs. */
  getVercelRuntimeLogs(id: string, limit?: number): Promise<VercelRuntimeLogLine[]>;
  runVercelDeploymentAction(
    id: string,
    action: VercelDeploymentAction,
  ): Promise<{ deployment?: { uid: string; url: string | null } }>;
}
