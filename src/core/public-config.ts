import { maskConnectionUrl } from "./db-peek.js";
import type {
  NoMoreIdeConfig,
  ProviderConnection,
  ServiceDefinition,
} from "./types.js";

export type PublicServiceDefinition = Omit<ServiceDefinition, "env">;

export type PublicProviderConnection = Omit<
  ProviderConnection,
  "token" | "refreshToken"
>;

export interface PublicNoMoreIdeConfig
  extends Omit<
    NoMoreIdeConfig,
    "services" | "databases" | "githubTokens" | "connections"
  > {
  services: PublicServiceDefinition[];
  databases: NoMoreIdeConfig["databases"];
  githubTokens: Array<Omit<NoMoreIdeConfig["githubTokens"][number], "token">>;
  connections: Record<string, PublicProviderConnection>;
}

/**
 * Project configuration safe to send to a dashboard client.
 *
 * The full config is intentionally a server-side capability: it contains
 * process environment values, database credentials, GitHub tokens, and
 * provider access/refresh tokens. Dashboard consumers only need the metadata
 * around those values, never the credentials themselves.
 */
export function publicConfig(config: NoMoreIdeConfig): PublicNoMoreIdeConfig {
  return {
    version: config.version,
    services: config.services.map((service) => ({
      name: service.name,
      ...(service.kind === undefined ? {} : { kind: service.kind }),
      ...(service.port === undefined ? {} : { port: service.port }),
      ...(service.description === undefined ? {} : { description: service.description }),
      ...(service.test === undefined ? {} : { test: service.test }),
      ...(service.dependsOn === undefined ? {} : { dependsOn: service.dependsOn }),
      ...(service.projectPath === undefined ? {} : { projectPath: service.projectPath }),
      ...(service.command === undefined ? {} : { command: service.command }),
      ...(service.args === undefined ? {} : { args: service.args }),
      ...(service.cwd === undefined ? {} : { cwd: service.cwd }),
      ...(service.composeFile === undefined ? {} : { composeFile: service.composeFile }),
      ...(service.composeService === undefined
        ? {}
        : { composeService: service.composeService }),
      ...(service.host === undefined ? {} : { host: service.host }),
    })),
    bundles: config.bundles,
    gitRepositories: config.gitRepositories,
    ...(config.selectedGitRepository === undefined
      ? {}
      : { selectedGitRepository: config.selectedGitRepository }),
    ...(config.gitBoardRepositories === undefined
      ? {}
      : { gitBoardRepositories: config.gitBoardRepositories }),
    databases: config.databases.map((database) => ({
      name: database.name,
      engine: database.engine,
      url: maskConnectionUrl(database.engine, database.url),
      ...(database.writeUnlocked === undefined
        ? {}
        : { writeUnlocked: database.writeUnlocked }),
      ...(database.projectPath === undefined ? {} : { projectPath: database.projectPath }),
    })),
    logSources: config.logSources,
    sshServers: config.sshServers,
    githubTokens: config.githubTokens.map((entry) => ({
      host: entry.host,
      ...(entry.login === undefined ? {} : { login: entry.login }),
      ...(entry.avatarUrl === undefined ? {} : { avatarUrl: entry.avatarUrl }),
    })),
    githubIdentities: config.githubIdentities,
    connections: Object.fromEntries(
      Object.entries(config.connections).map(([id, connection]) => [
        id,
        publicProviderConnection(connection),
      ]),
    ),
    workflows: config.workflows,
    workflowTriggers: config.workflowTriggers,
    ...(config.chatProvider === undefined ? {} : { chatProvider: config.chatProvider }),
    ...(config.chatModels === undefined ? {} : { chatModels: config.chatModels }),
    ...(config.preferences === undefined ? {} : { preferences: config.preferences }),
  };
}

function publicProviderConnection(
  connection: ProviderConnection,
): PublicProviderConnection {
  return {
    source: connection.source,
    ...(connection.expiresAt === undefined ? {} : { expiresAt: connection.expiresAt }),
    ...(connection.clientId === undefined ? {} : { clientId: connection.clientId }),
    ...(connection.scopeId === undefined ? {} : { scopeId: connection.scopeId }),
    ...(connection.scopeSlug === undefined ? {} : { scopeSlug: connection.scopeSlug }),
    ...(connection.username === undefined ? {} : { username: connection.username }),
  };
}
