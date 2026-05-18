import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type {
  BundleDefinition,
  NoMoreIdeConfig,
  GitRepositoryDefinition,
  ServiceDefinition,
} from "./types.js";

const serviceSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1),
  port: z.number().int().positive().max(65535).optional(),
  env: z.record(z.string()).optional(),
  description: z.string().optional(),
});

const bundleSchema = z.object({
  name: z.string().min(1),
  services: z.array(z.string().min(1)),
});

const gitRepositorySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});

const configSchema = z.object({
  version: z.literal(1),
  services: z.array(serviceSchema),
  bundles: z.array(bundleSchema),
  gitRepositories: z.array(gitRepositorySchema).default([]),
  selectedGitRepository: z.string().min(1).optional(),
});

const defaultConfig: NoMoreIdeConfig = {
  version: 1,
  services: [],
  bundles: [],
  gitRepositories: [],
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
    const config = await this.load();

    config.gitRepositories = [
      ...config.gitRepositories.filter(
        (item) => item.name !== parsedRepository.name,
      ),
      parsedRepository,
    ];
    config.selectedGitRepository ??= parsedRepository.name;

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
}

export class ConfigValidationError extends Error {}

function requireAbsolutePath(path: string): void {
  if (!isAbsolute(path)) {
    throw new ConfigValidationError(
      "Please add an absolute path. Paths beginning with ~ are not expanded here.",
    );
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
