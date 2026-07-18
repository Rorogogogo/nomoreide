import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  BundleDefinition,
  DatabaseConnection,
  LogSourceDefinition,
  NoMoreIdeConfig,
  ProjectPreferences,
  GitRepositoryDefinition,
  ServiceDefinition,
} from "./types.js";
import { workflowSchema, type Workflow } from "./workflows.js";
import { workflowTriggerSchema, type WorkflowTrigger } from "./workflow-triggers.js";

const execFileAsync = promisify(execFile);

const baseServiceSchema = z.object({
  name: z.string().min(1),
  port: z.number().int().positive().max(65535).optional(),
  description: z.string().optional(),
  /** Command used by the Test Runner; defaults to `npm test` when absent. */
  test: z.string().min(1).optional(),
  /** Services that must be running/healthy before this one (bundle start order). */
  dependsOn: z.array(z.string().min(1)).optional(),
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

const gitRepositorySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
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
    await this.enqueueMutation(() => this.persist(config));
  }

  private async persist(config: NoMoreIdeConfig): Promise<void> {
    const parsed = configSchema.parse(config);
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(this.configPath, `${JSON.stringify(parsed, null, 2)}\n`);
  }

  async getPreferences(): Promise<ProjectPreferences> {
    const config = await this.load();
    return structuredClone(config.preferences ?? DEFAULT_PROJECT_PREFERENCES);
  }

  async updatePreferences(
    patch: ProjectPreferencesPatch,
  ): Promise<ProjectPreferences> {
    const validatedPatch = projectPreferencesPatchSchema.parse(patch);
    return this.enqueueMutation(async () => {
      const config = await this.load();
      const current = config.preferences ?? DEFAULT_PROJECT_PREFERENCES;
      const next = projectPreferencesSchema.parse({
        logs: { ...current.logs, ...validatedPatch.logs },
        database: { ...current.database, ...validatedPatch.database },
      });
      config.preferences = next;
      await this.persist(config);
      return structuredClone(next);
    });
  }

  async resetPreferences(): Promise<ProjectPreferences> {
    return this.enqueueMutation(async () => {
      const config = await this.load();
      delete config.preferences;
      await this.persist(config);
      return structuredClone(DEFAULT_PROJECT_PREFERENCES);
    });
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
    return this.enqueueMutation(async () => {
      const config = await this.load();
      await mutation(config);
      await this.persist(config);
      return config;
    });
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
      config.gitRepositories = [
        ...config.gitRepositories.filter(
          (item) => item.name !== parsedRepository.name,
        ),
        parsedRepository,
      ];
      config.selectedGitRepository = parsedRepository.name;
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

  async setGithubToken(host: string, token: string): Promise<NoMoreIdeConfig> {
    const parsed = githubTokenSchema.parse({ host: host.trim(), token: token.trim() });
    return this.mutateConfig((config) => {
      config.githubTokens = [
        ...config.githubTokens.filter((t) => t.host !== parsed.host),
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

async function requireGitWorktree(path: string): Promise<void> {
  if (await isGitWorktree(path)) return;
  throw new ConfigValidationError(
    "Not a Git repository. Choose a folder inside a Git worktree.",
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
