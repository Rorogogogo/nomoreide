import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  open,
  realpath,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  BundleDefinition,
  DatabaseConnection,
  LogSourceDefinition,
  NoMoreIdeConfig,
  ProjectPreferences,
  GitRepositoryDefinition,
  GitHubCredentialSelection,
  GitHubIdentity,
  ServiceDefinition,
  VercelConnection,
} from "./types.js";
import { workflowSchema, type Workflow } from "./workflows.js";
import { workflowTriggerSchema, type WorkflowTrigger } from "./workflow-triggers.js";
import { GitWorktreeManager } from "./git-worktrees.js";

const execFileAsync = promisify(execFile);

const CONFIG_LOCK_WAIT_MS = 5_000;
const CONFIG_LOCK_STALE_MS = 30_000;
const CONFIG_LOCK_RETRY_MIN_MS = 10;
const CONFIG_LOCK_RETRY_MAX_MS = 50;

const baseServiceSchema = z.object({
  name: z.string().min(1),
  port: z.number().int().positive().max(65535).optional(),
  description: z.string().optional(),
  /** Command used by the Test Runner; defaults to `npm test` when absent. */
  test: z.string().min(1).optional(),
  /** Services that must be running/healthy before this one (bundle start order). */
  dependsOn: z.array(z.string().min(1)).optional(),
  /**
   * Explicit project assignment, overriding the cwd-containment inference.
   * Needed because a remote service's `cwd` is a path on another machine
   * (`/var/www/...`, `/root`) and can never sit under a local repo root, so
   * inference alone leaves those services in no project at all.
   */
  projectPath: z.string().min(1).optional(),
});

const localServiceSchema = baseServiceSchema.extend({
  kind: z.literal("local").optional(),
  command: z.string().min(1),
  cwd: z.string().min(1),
  env: z.record(z.string()).optional(),
});

const dockerServiceSchema = baseServiceSchema.extend({
  kind: z.literal("docker-compose"),
  cwd: z.string().min(1),
  composeFile: z.string().min(1).optional(),
  composeService: z.string().min(1),
});

const sshServiceSchema = baseServiceSchema.extend({
  kind: z.literal("ssh"),
  host: z.string().min(1),
  cwd: z.string().min(1),
  command: z
    .string()
    .min(1)
    .refine((value) => !value.includes("\0"), {
      message: "SSH command contains invalid null byte.",
    }),
  env: z.record(z.string()).optional(),
});

const serviceSchema = z.union([
  localServiceSchema,
  dockerServiceSchema,
  sshServiceSchema,
]);

const bundleSchema = z.object({
  name: z.string().min(1),
  services: z.array(z.string().min(1)),
});

const githubCredentialSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("gh"),
    host: z.string().min(1),
    login: z.string().min(1),
  }),
  z.object({
    source: z.literal("stored"),
    host: z.string().min(1),
  }),
]);

const gitRepositorySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  activeWorktreePath: z.string().min(1).optional(),
  githubCredential: githubCredentialSchema.optional(),
  vercelProjectId: z.string().min(1).optional(),
});

/** Upper bound on board-pinned repos, mirroring the web UI's 5-column cap. */
const MAX_BOARD_REPOSITORIES = 5;

const databaseSchema = z.object({
  name: z.string().min(1),
  engine: z.enum(["postgres", "mysql", "sqlite"]),
  url: z.string().min(1),
  writeUnlocked: z.boolean().optional(),
  projectPath: z.string().min(1).optional(),
});

const logSourceSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(["file", "ssh", "command"]),
    path: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    driver: z.enum(["journald", "docker"]).optional(),
    unit: z.string().min(1).optional(),
    container: z.string().min(1).optional(),
  })
  .superRefine((source, ctx) => {
    if (source.driver === "journald") {
      if (!source.unit) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "journald log source requires a unit." });
      }
      return; // driver sources build their own query; kind-based paths don't apply.
    }
    if (source.driver === "docker") {
      if (!source.container) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "docker log source requires a container." });
      }
      return;
    }
    if (source.kind === "file" && !source.path) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "File log source requires a path." });
    }
    if (source.kind === "ssh" && (!source.host || !source.path)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SSH log source requires host and path." });
    }
    if (source.kind === "command" && !source.command) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Command log source requires a command." });
    }
  });

const githubTokenSchema = z.object({
  host: z.string().min(1),
  token: z.string().min(1),
  /**
   * Who the token belongs to, captured once at connect time. Optional because
   * tokens stored before this existed stay valid — the GitHub status route
   * backfills them on the next check.
   */
  login: z.string().min(1).optional(),
  avatarUrl: z.string().url().optional(),
});

/**
 * Commit identity for a GitHub account, cached so committing does not spend an
 * API call resolving a name and address that effectively never change.
 */
const githubIdentitySchema = z.object({
  host: z.string().min(1),
  login: z.string().min(1),
  name: z.string().min(1),
  email: z.string().min(1),
});

/**
 * The Vercel connection. A `cli` connection stores no token — it is re-read
 * from the Vercel CLI's auth file per request — so `token` is set only for
 * `stored` (the pasted token) and `oauth` (the current access token, alongside
 * the refresh token that renews it).
 */
const vercelConnectionSchema = z.object({
  source: z.enum(["cli", "stored", "oauth"]),
  token: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().int().positive().optional(),
  clientId: z.string().min(1).optional(),
  teamId: z.string().min(1).optional(),
  teamSlug: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
});

export const projectPreferencesSchema: z.ZodType<ProjectPreferences> = z
  .object({
    logs: z
      .object({
        showTimestamps: z.boolean(),
        wrapLines: z.boolean(),
      })
      .strict(),
    database: z
      .object({
        confirmWrites: z.boolean(),
        resultLimit: z.number().int().min(10).max(5_000),
      })
      .strict(),
  })
  .strict();

export const projectPreferencesPatchSchema = z
  .object({
    logs: z
      .object({
        showTimestamps: z.boolean().optional(),
        wrapLines: z.boolean().optional(),
      })
      .strict()
      .optional(),
    database: z
      .object({
        confirmWrites: z.boolean().optional(),
        resultLimit: z.number().int().min(10).max(5_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ProjectPreferencesPatch = z.infer<
  typeof projectPreferencesPatchSchema
>;

export const DEFAULT_PROJECT_PREFERENCES: ProjectPreferences = Object.freeze({
  logs: Object.freeze({ showTimestamps: true, wrapLines: true }),
  database: Object.freeze({ confirmWrites: true, resultLimit: 100 }),
});

const configSchema = z.object({
  version: z.literal(1),
  services: z.array(serviceSchema),
  bundles: z.array(bundleSchema),
  gitRepositories: z.array(gitRepositorySchema).default([]),
  selectedGitRepository: z.string().min(1).optional(),
  /**
   * Ordered names of repositories pinned to the multi-repo board. Undefined
   * means "never curated" → the board shows every registered repo; an empty
   * array means the user has explicitly cleared the board.
   */
  gitBoardRepositories: z.array(z.string().min(1)).optional(),
  databases: z.array(databaseSchema).default([]),
  logSources: z.array(logSourceSchema).default([]),
  githubTokens: z.array(githubTokenSchema).default([]),
  githubIdentities: z.array(githubIdentitySchema).default([]),
  /** How the Vercel integration authenticates; absent = not connected. */
  vercel: vercelConnectionSchema.optional(),
  workflows: z.array(workflowSchema).default([]),
  /** Event→workflow bindings that auto-fire workflows (IDEAS #16). */
  workflowTriggers: z.array(workflowTriggerSchema).default([]),
  /**
   * Which CLI the in-dock agent chat drives. Undefined = "never chosen" → fall
   * back to startup-agent detection. Set explicitly when the user picks/switches
   * providers, so the choice sticks across CLI/web/desktop.
   */
  chatProvider: z.enum(["claude", "codex"]).optional(),
  preferences: projectPreferencesSchema.optional(),
});

const defaultConfig: NoMoreIdeConfig = {
  version: 1,
  services: [],
  bundles: [],
  gitRepositories: [],
  databases: [],
  logSources: [],
  githubTokens: [],
  githubIdentities: [],
  workflows: [],
  workflowTriggers: [],
};

export function defaultGlobalConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim();
  const root = base && base.length > 0 ? base : join(homedir(), ".config");
  return join(root, "nomoreide", "config.json");
}

export class ConfigStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly configPath = defaultGlobalConfigPath()) {}

  async load(): Promise<NoMoreIdeConfig> {
    return this.loadUnlocked();
  }

  private async loadUnlocked(): Promise<NoMoreIdeConfig> {
    try {
      const raw = await readFile(this.configPath, "utf8");
      return configSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (isMissingFileError(error)) {
        return structuredClone(defaultConfig);
      }

      throw error;
    }
  }

  async save(config: NoMoreIdeConfig): Promise<void> {
    await this.enqueueMutation(() =>
      this.withConfigLock(() => this.persistUnlocked(config)),
    );
  }

  private async persistUnlocked(config: NoMoreIdeConfig): Promise<void> {
    const parsed = configSchema.parse(config);
    const parentDirectory = dirname(this.configPath);
    const temporaryPath = join(
      parentDirectory,
      `.${basename(this.configPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    await mkdir(parentDirectory, { recursive: true });
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(parsed, null, 2)}\n`,
        { flag: "wx" },
      );
      await rename(temporaryPath, this.configPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async getPreferences(): Promise<ProjectPreferences> {
    const config = await this.load();
    return structuredClone(config.preferences ?? DEFAULT_PROJECT_PREFERENCES);
  }

  async updatePreferences(
    patch: ProjectPreferencesPatch,
  ): Promise<ProjectPreferences> {
    const validatedPatch = projectPreferencesPatchSchema.parse(patch);
    return this.enqueueMutation(() =>
      this.withConfigLock(async () => {
        const config = await this.loadUnlocked();
        const current = config.preferences ?? DEFAULT_PROJECT_PREFERENCES;
        const next = projectPreferencesSchema.parse({
          logs: { ...current.logs, ...validatedPatch.logs },
          database: { ...current.database, ...validatedPatch.database },
        });
        config.preferences = next;
        await this.persistUnlocked(config);
        return structuredClone(next);
      }),
    );
  }

  async resetPreferences(): Promise<ProjectPreferences> {
    return this.enqueueMutation(() =>
      this.withConfigLock(async () => {
        const config = await this.loadUnlocked();
        delete config.preferences;
        await this.persistUnlocked(config);
        return structuredClone(DEFAULT_PROJECT_PREFERENCES);
      }),
    );
  }

  private async withConfigLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.configPath}.lock`;
    const lock = await acquireConfigLock(lockPath);
    try {
      return await operation();
    } finally {
      await lock.handle.close().finally(() =>
        releaseConfigLock(lockPath, lock.ownerToken),
      );
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private mutateConfig(
    mutation: (config: NoMoreIdeConfig) => void | Promise<void>,
  ): Promise<NoMoreIdeConfig> {
    return this.enqueueMutation(() =>
      this.withConfigLock(async () => {
        const config = await this.loadUnlocked();
        await mutation(config);
        await this.persistUnlocked(config);
        return config;
      }),
    );
  }

  async registerService(service: ServiceDefinition): Promise<NoMoreIdeConfig> {
    const parsedService = serviceSchema.parse(service);
    return this.mutateConfig((config) => {
      config.services = [
        ...config.services.filter((item) => item.name !== parsedService.name),
        parsedService,
      ];
    });
  }

  /**
   * Patches only the project assignment. Reassignment goes through here rather
   * than `registerService` because that replaces the whole definition by name —
   * a caller would have to resend every field, and any field it did not know
   * about would be silently dropped.
   *
   * A blank or absent `projectPath` clears the assignment back to cwd inference.
   */
  async setServiceProject(
    name: string,
    projectPath: string | undefined,
  ): Promise<NoMoreIdeConfig> {
    const serviceName = name.trim();
    if (!serviceName) {
      throw new ConfigValidationError("service name is required");
    }
    const assigned = projectPath?.trim();

    return this.mutateConfig((config) => {
      const service = config.services.find((item) => item.name === serviceName);
      if (!service) {
        throw new Error(`Service "${serviceName}" is not registered.`);
      }
      if (assigned) {
        service.projectPath = assigned;
      } else {
        delete service.projectPath;
      }
    });
  }

  async removeService(name: string): Promise<NoMoreIdeConfig> {
    const serviceName = name.trim();
    if (!serviceName) {
      throw new ConfigValidationError("service name is required");
    }

    return this.mutateConfig((config) => {
      const nextServices = config.services.filter((item) => item.name !== serviceName);
      if (nextServices.length === config.services.length) {
        throw new Error(`Service "${serviceName}" is not registered.`);
      }

      config.services = nextServices;
      config.bundles = config.bundles.map((bundle) => ({
        ...bundle,
        services: bundle.services.filter((service) => service !== serviceName),
      }));
    });
  }

  async registerBundle(
    bundle: BundleDefinition,
    previousName?: string,
  ): Promise<NoMoreIdeConfig> {
    const parsedBundle = bundleSchema.parse(bundle);
    return this.mutateConfig((config) => {
      config.bundles = [
        ...config.bundles.filter(
          (item) => item.name !== parsedBundle.name && item.name !== previousName,
        ),
        parsedBundle,
      ];
    });
  }

  async registerGitRepository(
    repository: GitRepositoryDefinition,
  ): Promise<NoMoreIdeConfig> {
    const parsedRepository = gitRepositorySchema.parse(repository);
    requireAbsolutePath(parsedRepository.path);
    await requireGitWorktree(parsedRepository.path);
    return this.mutateConfig((config) => {
      const existing = config.gitRepositories.find(
        (item) => item.name === parsedRepository.name,
      );
      if (!parsedRepository.githubCredential && existing?.githubCredential) {
        parsedRepository.githubCredential = existing.githubCredential;
      }
      if (!parsedRepository.vercelProjectId && existing?.vercelProjectId) {
        parsedRepository.vercelProjectId = existing.vercelProjectId;
      }
      config.gitRepositories = [
        ...config.gitRepositories.filter(
          (item) => item.name !== parsedRepository.name,
        ),
        parsedRepository,
      ];
      config.selectedGitRepository = parsedRepository.name;
    });
  }

  async setGitHubCredential(
    repositoryName: string,
    credential: GitHubCredentialSelection,
  ): Promise<NoMoreIdeConfig> {
    const parsed = githubCredentialSchema.parse(credential);
    return this.mutateConfig((config) => {
      const repository = config.gitRepositories.find(
        (item) => item.name === repositoryName.trim(),
      );
      if (!repository) {
        throw new Error(`Git repository "${repositoryName}" is not registered.`);
      }
      repository.githubCredential = parsed;
    });
  }

  async removeGitRepository(name: string): Promise<NoMoreIdeConfig> {
    const repositoryName = name.trim();
    if (!repositoryName) {
      throw new ConfigValidationError("repository name is required");
    }

    return this.mutateConfig((config) => {
      const nextRepositories = config.gitRepositories.filter(
        (repository) => repository.name !== repositoryName,
      );
      if (nextRepositories.length === config.gitRepositories.length) {
        throw new Error(`Git repository "${repositoryName}" is not registered.`);
      }

      config.gitRepositories = nextRepositories;
      if (config.selectedGitRepository === repositoryName) {
        delete config.selectedGitRepository;
      }
    });
  }

  /**
   * Persist the ordered set of repositories pinned to the board. Names are
   * filtered to those still registered, de-duped (order preserved), and capped
   * at {@link MAX_BOARD_REPOSITORIES} so a stale, repeated, or overflowing list
   * from the client can never corrupt the board or strand repos off-screen.
   */
  async setGitBoardRepositories(names: string[]): Promise<NoMoreIdeConfig> {
    return this.mutateConfig((config) => {
      const registered = new Set(config.gitRepositories.map((repo) => repo.name));
      const seen = new Set<string>();
      config.gitBoardRepositories = names
        .filter((name) => {
          if (!registered.has(name) || seen.has(name)) return false;
          seen.add(name);
          return true;
        })
        .slice(0, MAX_BOARD_REPOSITORIES);
    });
  }

  async selectGitRepository(name: string): Promise<NoMoreIdeConfig> {
    return this.mutateConfig((config) => {
      if (!config.gitRepositories.some((repository) => repository.name === name)) {
        throw new Error(`Git repository "${name}" is not registered.`);
      }
      config.selectedGitRepository = name;
    });
  }

  async selectGitWorktree(name: string, path: string): Promise<NoMoreIdeConfig> {
    requireAbsolutePath(path);
    const config = await this.load();
    const repository = config.gitRepositories.find((item) => item.name === name);
    if (!repository) {
      throw new Error(`Git repository "${name}" is not registered.`);
    }
    const worktrees = await new GitWorktreeManager(repository.path).list();
    const canonicalPath = await realpath(path).catch(() => path);
    const canonicalWorktrees = await Promise.all(
      worktrees.map((worktree) => realpath(worktree.path).catch(() => worktree.path)),
    );
    const selectedIndex = canonicalWorktrees.indexOf(canonicalPath);
    if (selectedIndex < 0) {
      throw new ConfigValidationError(
        "The selected folder is not a worktree of this project.",
      );
    }
    const selectedPath = worktrees[selectedIndex].path;
    return this.mutateConfig((next) => {
      const target = next.gitRepositories.find((item) => item.name === name);
      if (target) target.activeWorktreePath = selectedPath;
    });
  }

  /** Persist which agent CLI the in-dock chat drives. */
  async setChatProvider(provider: "claude" | "codex"): Promise<NoMoreIdeConfig> {
    return this.mutateConfig((config) => {
      config.chatProvider = provider;
    });
  }

  async registerDatabase(
    database: DatabaseConnection,
  ): Promise<NoMoreIdeConfig> {
    const parsed = databaseSchema.parse(database);
    return this.mutateConfig((config) => {
      config.databases = [
        ...config.databases.filter((item) => item.name !== parsed.name),
        parsed,
      ];
    });
  }

  async removeDatabase(name: string): Promise<NoMoreIdeConfig> {
    return this.mutateConfig((config) => {
      config.databases = config.databases.filter((item) => item.name !== name);
    });
  }

  /** Lock or unlock write access for a single connection's SQL console. */
  async setDatabaseWriteAccess(
    name: string,
    unlocked: boolean,
  ): Promise<NoMoreIdeConfig> {
    return this.mutateConfig((config) => {
      const connection = config.databases.find((item) => item.name === name);
      if (!connection) {
        throw new Error(`Database connection "${name}" is not registered.`);
      }
      connection.writeUnlocked = unlocked;
    });
  }

  async registerLogSource(source: LogSourceDefinition): Promise<NoMoreIdeConfig> {
    const parsed = logSourceSchema.parse(source);
    return this.mutateConfig((config) => {
      config.logSources = [
        ...config.logSources.filter((item) => item.name !== parsed.name),
        parsed,
      ];
    });
  }

  async removeLogSource(name: string): Promise<NoMoreIdeConfig> {
    return this.mutateConfig((config) => {
      config.logSources = config.logSources.filter((item) => item.name !== name);
    });
  }

  async setGithubToken(
    host: string,
    token: string,
    profile?: { login?: string; avatarUrl?: string },
  ): Promise<NoMoreIdeConfig> {
    const parsed = githubTokenSchema.parse({
      host: host.trim(),
      token: token.trim(),
      login: profile?.login?.trim() || undefined,
      avatarUrl: profile?.avatarUrl?.trim() || undefined,
    });
    return this.mutateConfig((config) => {
      config.githubTokens = [
        ...config.githubTokens.filter((t) => t.host !== parsed.host),
        parsed,
      ];
    });
  }

  /** Cached account identity for a stored token, when one was captured. */
  getGithubProfile(
    config: NoMoreIdeConfig,
    host = "github.com",
  ): { login: string; avatarUrl?: string } | undefined {
    const entry = config.githubTokens.find((t) => t.host === host);
    if (!entry?.login) return undefined;
    return { login: entry.login, avatarUrl: entry.avatarUrl };
  }

  /** Attach identity to an already-stored token without touching the secret. */
  async setGithubProfile(
    host: string,
    profile: { login: string; avatarUrl?: string },
  ): Promise<NoMoreIdeConfig> {
    return this.mutateConfig((config) => {
      config.githubTokens = config.githubTokens.map((entry) =>
        entry.host === host.trim()
          ? { ...entry, login: profile.login, avatarUrl: profile.avatarUrl }
          : entry,
      );
    });
  }

  /** Cached commit identity for a GitHub account, when one has been resolved. */
  getGithubIdentity(
    config: NoMoreIdeConfig,
    host: string,
    login: string,
  ): GitHubIdentity | undefined {
    return config.githubIdentities.find(
      (entry) => entry.host === host && entry.login.toLowerCase() === login.toLowerCase(),
    );
  }

  async setGithubIdentity(identity: GitHubIdentity): Promise<NoMoreIdeConfig> {
    const parsed = githubIdentitySchema.parse(identity);
    return this.mutateConfig((config) => {
      config.githubIdentities = [
        ...config.githubIdentities.filter(
          (entry) =>
            entry.host !== parsed.host ||
            entry.login.toLowerCase() !== parsed.login.toLowerCase(),
        ),
        parsed,
      ];
    });
  }

  async removeGithubToken(host: string): Promise<NoMoreIdeConfig> {
    return this.mutateConfig((config) => {
      config.githubTokens = config.githubTokens.filter(
        (t) => t.host !== host.trim(),
      );
    });
  }

  getGithubToken(config: NoMoreIdeConfig, host = "github.com"): string | undefined {
    return config.githubTokens.find((t) => t.host === host)?.token;
  }

  /**
   * Save how Vercel is connected. A `cli` connection deliberately drops any
   * token it was handed: the CLI's auth file stays the single source, so
   * `vercel logout` also revokes us instead of leaving a stale copy behind.
   */
  async setVercelConnection(
    connection: VercelConnection,
  ): Promise<NoMoreIdeConfig> {
    const parsed = vercelConnectionSchema.parse(connection);
    if (parsed.source === "cli") {
      delete parsed.token;
    } else if (!parsed.token) {
      throw new ConfigValidationError("a Vercel token is required");
    }
    if (parsed.source === "oauth" && !parsed.clientId) {
      throw new ConfigValidationError("a Vercel OAuth connection needs its client id");
    }
    return this.mutateConfig((config) => {
      config.vercel = parsed;
    });
  }

  /**
   * Persist the tokens a refresh returned. Separate from
   * {@link setVercelConnection} because it runs mid-request on an already
   * connected account, and must not disturb the team scope or cached username.
   */
  async updateVercelTokens(tokens: {
    token: string;
    refreshToken?: string;
    expiresAt: number;
  }): Promise<NoMoreIdeConfig> {
    return this.mutateConfig((config) => {
      if (config.vercel?.source !== "oauth") return;
      config.vercel = {
        ...config.vercel,
        token: tokens.token,
        // Vercel rotates refresh tokens; keep the previous one only if this
        // response omitted a replacement, or the connection becomes unrenewable.
        refreshToken: tokens.refreshToken ?? config.vercel.refreshToken,
        expiresAt: tokens.expiresAt,
      };
    });
  }

  /** Re-scope an existing connection to a team without re-entering the token. */
  async setVercelScope(
    scope: { teamId?: string; teamSlug?: string },
  ): Promise<NoMoreIdeConfig> {
    return this.mutateConfig((config) => {
      if (!config.vercel) throw new Error("Vercel is not connected.");
      config.vercel = {
        ...config.vercel,
        teamId: scope.teamId?.trim() || undefined,
        teamSlug: scope.teamSlug?.trim() || undefined,
      };
    });
  }

  async removeVercelConnection(): Promise<NoMoreIdeConfig> {
    return this.mutateConfig((config) => {
      delete config.vercel;
    });
  }

  /** Pin which Vercel project a registered repository deploys. */
  async setVercelProject(
    repositoryName: string,
    projectId: string | undefined,
  ): Promise<NoMoreIdeConfig> {
    return this.mutateConfig((config) => {
      const repository = config.gitRepositories.find(
        (item) => item.name === repositoryName.trim(),
      );
      if (!repository) {
        throw new Error(`Git repository "${repositoryName}" is not registered.`);
      }
      const id = projectId?.trim();
      if (id) repository.vercelProjectId = id;
      else delete repository.vercelProjectId;
    });
  }

  /** Persist a user-saved/forked workflow (replaces one with the same id). */
  async saveWorkflow(workflow: Workflow): Promise<NoMoreIdeConfig> {
    const parsed = workflowSchema.parse(workflow);
    return this.mutateConfig((config) => {
      config.workflows = [
        ...config.workflows.filter((item) => item.id !== parsed.id),
        parsed,
      ];
    });
  }

  async removeWorkflow(id: string): Promise<NoMoreIdeConfig> {
    return this.mutateConfig((config) => {
      config.workflows = config.workflows.filter((item) => item.id !== id.trim());
    });
  }

  /** Persist an event→workflow trigger (replaces one with the same id). */
  async saveWorkflowTrigger(trigger: WorkflowTrigger): Promise<NoMoreIdeConfig> {
    const parsed = workflowTriggerSchema.parse(trigger);
    return this.mutateConfig((config) => {
      config.workflowTriggers = [
        ...config.workflowTriggers.filter((item) => item.id !== parsed.id),
        parsed,
      ];
    });
  }

  async removeWorkflowTrigger(id: string): Promise<NoMoreIdeConfig> {
    return this.mutateConfig((config) => {
      config.workflowTriggers = config.workflowTriggers.filter(
        (item) => item.id !== id.trim(),
      );
    });
  }
}

export class ConfigValidationError extends Error {}

function requireAbsolutePath(path: string): void {
  if (!isAbsolute(path)) {
    throw new ConfigValidationError(
      "Please add an absolute path. Paths beginning with ~ are not expanded here.",
    );
  }
}

export async function isGitWorktree(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: path },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * The worktree root enclosing `path`, or null when it is not inside a repo.
 *
 * Registering a service's own `cwd` is usually the wrong granularity — a service
 * often runs from a subdirectory (`repo/frontend`), and a project pinned there
 * would fight the path-based grouping. Resolving to the root first is what makes
 * "adopt this service's folder" produce the project the user actually meant.
 */
export async function gitToplevel(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: path,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function requireGitWorktree(path: string): Promise<void> {
  if (await isGitWorktree(path)) return;
  throw new ConfigValidationError(
    "Not a Git repository. Choose a folder inside a Git worktree.",
  );
}

async function acquireConfigLock(lockPath: string) {
  await mkdir(dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  let attempts = 0;

  while (Date.now() - startedAt < CONFIG_LOCK_WAIT_MS) {
    try {
      const handle = await open(lockPath, "wx");
      const ownerToken = `${process.pid}:${randomUUID()}`;
      try {
        await handle.writeFile(ownerToken, "utf8");
        return { handle, ownerToken };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }

    if (await recoverStaleConfigLock(lockPath)) {
      continue;
    }

    attempts += 1;
    const retryDelay = Math.min(
      CONFIG_LOCK_RETRY_MIN_MS * attempts,
      CONFIG_LOCK_RETRY_MAX_MS,
    );
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, retryDelay);
    });
  }

  throw new Error(`Timed out waiting for config lock: ${lockPath}`);
}

async function releaseConfigLock(
  lockPath: string,
  ownerToken: string,
): Promise<boolean> {
  let currentOwner: string;
  try {
    currentOwner = await readFile(lockPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
  if (currentOwner !== ownerToken) return false;

  try {
    await unlink(lockPath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  return true;
}

async function recoverStaleConfigLock(
  lockPath: string,
  afterOwnerRead?: () => void | Promise<void>,
): Promise<boolean> {
  let observedOwner: string;
  try {
    observedOwner = await readFile(lockPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }

  await afterOwnerRead?.();

  let lockMtimeMs: number;
  try {
    lockMtimeMs = (await stat(lockPath)).mtimeMs;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
  if (Date.now() - lockMtimeMs <= CONFIG_LOCK_STALE_MS) return false;
  return releaseConfigLock(lockPath, observedOwner);
}

/** @internal Deterministic stale-lock ownership seam used by regression tests. */
export async function __recoverStaleConfigLockForTests(
  lockPath: string,
  afterOwnerRead: () => void | Promise<void>,
): Promise<void> {
  await recoverStaleConfigLock(lockPath, afterOwnerRead);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isMissingFileError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}
