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
  GitRepositoryDefinition,
  ServiceDefinition,
} from "./types.js";

const execFileAsync = promisify(execFile);

const baseServiceSchema = z.object({
  name: z.string().min(1),
  port: z.number().int().positive().max(65535).optional(),
  description: z.string().optional(),
  /** Command used by the Test Runner; defaults to `npm test` when absent. */
  test: z.string().min(1).optional(),
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

const databaseSchema = z.object({
  name: z.string().min(1),
  engine: z.enum(["postgres", "mysql", "sqlite"]),
  url: z.string().min(1),
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

const configSchema = z.object({
  version: z.literal(1),
  services: z.array(serviceSchema),
  bundles: z.array(bundleSchema),
  gitRepositories: z.array(gitRepositorySchema).default([]),
  selectedGitRepository: z.string().min(1).optional(),
  databases: z.array(databaseSchema).default([]),
  logSources: z.array(logSourceSchema).default([]),
});

const defaultConfig: NoMoreIdeConfig = {
  version: 1,
  services: [],
  bundles: [],
  gitRepositories: [],
  databases: [],
  logSources: [],
};

export function defaultGlobalConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim();
  const root = base && base.length > 0 ? base : join(homedir(), ".config");
  return join(root, "nomoreide", "config.json");
}

export class ConfigStore {
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
    const parsed = configSchema.parse(config);
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(this.configPath, `${JSON.stringify(parsed, null, 2)}\n`);
  }

  async registerService(service: ServiceDefinition): Promise<NoMoreIdeConfig> {
    const parsedService = serviceSchema.parse(service);
    const config = await this.load();

    config.services = [
      ...config.services.filter((item) => item.name !== parsedService.name),
      parsedService,
    ];

    await this.save(config);
    return config;
  }

  async registerBundle(
    bundle: BundleDefinition,
    previousName?: string,
  ): Promise<NoMoreIdeConfig> {
    const parsedBundle = bundleSchema.parse(bundle);
    const config = await this.load();

    config.bundles = [
      ...config.bundles.filter(
        (item) => item.name !== parsedBundle.name && item.name !== previousName,
      ),
      parsedBundle,
    ];

    await this.save(config);
    return config;
  }

  async registerGitRepository(
    repository: GitRepositoryDefinition,
  ): Promise<NoMoreIdeConfig> {
    const parsedRepository = gitRepositorySchema.parse(repository);
    requireAbsolutePath(parsedRepository.path);
    await requireGitWorktree(parsedRepository.path);
    const config = await this.load();

    config.gitRepositories = [
      ...config.gitRepositories.filter(
        (item) => item.name !== parsedRepository.name,
      ),
      parsedRepository,
    ];
    config.selectedGitRepository = parsedRepository.name;

    await this.save(config);
    return config;
  }

  async removeGitRepository(name: string): Promise<NoMoreIdeConfig> {
    const repositoryName = name.trim();
    if (!repositoryName) {
      throw new ConfigValidationError("repository name is required");
    }

    const config = await this.load();
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

    await this.save(config);
    return config;
  }

  async selectGitRepository(name: string): Promise<NoMoreIdeConfig> {
    const config = await this.load();

    if (!config.gitRepositories.some((repository) => repository.name === name)) {
      throw new Error(`Git repository "${name}" is not registered.`);
    }

    config.selectedGitRepository = name;
    await this.save(config);
    return config;
  }

  async registerDatabase(
    database: DatabaseConnection,
  ): Promise<NoMoreIdeConfig> {
    const parsed = databaseSchema.parse(database);
    const config = await this.load();

    config.databases = [
      ...config.databases.filter((item) => item.name !== parsed.name),
      parsed,
    ];

    await this.save(config);
    return config;
  }

  async removeDatabase(name: string): Promise<NoMoreIdeConfig> {
    const config = await this.load();
    config.databases = config.databases.filter((item) => item.name !== name);
    await this.save(config);
    return config;
  }

  async registerLogSource(source: LogSourceDefinition): Promise<NoMoreIdeConfig> {
    const parsed = logSourceSchema.parse(source);
    const config = await this.load();

    config.logSources = [
      ...config.logSources.filter((item) => item.name !== parsed.name),
      parsed,
    ];

    await this.save(config);
    return config;
  }

  async removeLogSource(name: string): Promise<NoMoreIdeConfig> {
    const config = await this.load();
    config.logSources = config.logSources.filter((item) => item.name !== name);
    await this.save(config);
    return config;
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

async function requireGitWorktree(path: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: path },
    );
    if (stdout.trim() === "true") return;
  } catch {
    // Re-throw a user-facing validation error below.
  }

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
