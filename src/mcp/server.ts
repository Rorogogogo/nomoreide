import { resolve } from "node:path";
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { ConfigStore } from "../core/config-store.js";
import { GitManager } from "../core/git-manager.js";
import { LogStore } from "../core/log-store.js";
import { ProcessManager } from "../core/process-manager.js";
import {
  createUiLifecycleManager,
  type UiLifecycleManager,
} from "../web/ui-lifecycle.js";

export const NOMOREIDE_TOOL_NAMES = [
  "nomoreide_list_services",
  "nomoreide_register_service",
  "nomoreide_start_service",
  "nomoreide_stop_service",
  "nomoreide_restart_service",
  "nomoreide_read_logs",
  "nomoreide_register_bundle",
  "nomoreide_start_bundle",
  "nomoreide_stop_bundle",
  "nomoreide_status",
  "nomoreide_git_status",
  "nomoreide_git_branches",
  "nomoreide_git_switch_branch",
  "nomoreide_git_create_branch",
  "nomoreide_git_fetch",
  "nomoreide_git_diff",
  "nomoreide_git_staged_diff",
  "nomoreide_git_log",
  "nomoreide_git_stage",
  "nomoreide_git_unstage",
  "nomoreide_git_commit",
  "nomoreide_git_register_repository",
  "nomoreide_git_select_repository",
  "nomoreide_open_ui",
  "nomoreide_close_ui",
] as const;

interface CreateNoMoreIdeMcpServerOptions {
  configPath?: string;
  logDir?: string;
  uiLifecycle?: UiLifecycleManager;
  uiPort?: number;
}

export interface NoMoreIdeMcpServer {
  server: FastMCP;
  configStore: ConfigStore;
  logStore: LogStore;
  manager: ProcessManager;
  uiLifecycle: UiLifecycleManager;
  toolNames: typeof NOMOREIDE_TOOL_NAMES;
}

interface StartNoMoreIdeMcpServerOptions {
  env?: NodeJS.ProcessEnv;
  createServer?: () => Pick<NoMoreIdeMcpServer, "server" | "uiLifecycle">;
}

const serviceNameSchema = z.object({
  name: z.string().min(1).describe("Registered service name."),
});

const bundleNameSchema = z.object({
  name: z.string().min(1).describe("Registered bundle name."),
});

const gitCwdSchema = z.object({
  cwd: z.string().min(1).optional().describe("Git repository directory."),
});

const gitPathSchema = gitCwdSchema.extend({
  path: z.string().min(1).optional().describe("Optional file path."),
});

const gitBranchSchema = gitCwdSchema.extend({
  name: z.string().min(1).describe("Branch name."),
});

const gitPathsSchema = gitCwdSchema.extend({
  paths: z.array(z.string().min(1)).min(1),
});

export function createNoMoreIdeMcpServer(
  options: CreateNoMoreIdeMcpServerOptions = {},
): NoMoreIdeMcpServer {
  const configPath = options.configPath ?? resolve(process.cwd(), "nomoreide.config.json");
  const logDir = options.logDir ?? resolve(process.cwd(), ".nomoreide/logs");
  const configStore = new ConfigStore(
    configPath,
  );
  const logStore = new LogStore({
    baseDir: logDir,
  });
  const manager = new ProcessManager({ configStore, logStore });
  const uiLifecycle =
    options.uiLifecycle ??
    createUiLifecycleManager({
      configPath,
      logDir,
      port: options.uiPort,
    });
  const server = new FastMCP({
    name: "NoMoreIDE MCP",
    version: "0.1.0",
  });

  server.addTool({
    name: "nomoreide_list_services",
    description: "List registered NoMoreIDE services and bundles.",
    execute: async () => stringify(await configStore.load()),
  });

  server.addTool({
    name: "nomoreide_register_service",
    description: "Register or replace a local development service.",
    parameters: z.object({
      name: z.string().min(1),
      command: z.string().min(1),
      cwd: z.string().min(1),
      port: z.number().int().positive().max(65535).optional(),
      env: z.record(z.string()).optional(),
      description: z.string().optional(),
    }),
    execute: async (args) => stringify(await configStore.registerService(args)),
  });

  server.addTool({
    name: "nomoreide_start_service",
    description: "Start a registered service.",
    parameters: serviceNameSchema,
    execute: async ({ name }) => stringify(await manager.startService(name)),
  });

  server.addTool({
    name: "nomoreide_stop_service",
    description: "Stop a running NoMoreIDE service.",
    parameters: serviceNameSchema,
    execute: async ({ name }) => stringify(await manager.stopService(name)),
  });

  server.addTool({
    name: "nomoreide_restart_service",
    description: "Restart a registered service.",
    parameters: serviceNameSchema,
    execute: async ({ name }) => stringify(await manager.restartService(name)),
  });

  server.addTool({
    name: "nomoreide_read_logs",
    description: "Read recent in-memory logs for a registered service.",
    parameters: z.object({
      name: z.string().min(1),
      limit: z.number().int().positive().max(1000).optional(),
    }),
    execute: async ({ name, limit }) => stringify(logStore.read(name, limit)),
  });

  server.addTool({
    name: "nomoreide_register_bundle",
    description: "Register or replace a bundle of services.",
    parameters: z.object({
      name: z.string().min(1),
      services: z.array(z.string().min(1)).min(1),
    }),
    execute: async (args) => stringify(await configStore.registerBundle(args)),
  });

  server.addTool({
    name: "nomoreide_start_bundle",
    description: "Start every service in a registered bundle.",
    parameters: bundleNameSchema,
    execute: async ({ name }) => stringify(await manager.startBundle(name)),
  });

  server.addTool({
    name: "nomoreide_stop_bundle",
    description: "Stop every service in a registered bundle.",
    parameters: bundleNameSchema,
    execute: async ({ name }) => stringify(await manager.stopBundle(name)),
  });

  server.addTool({
    name: "nomoreide_status",
    description: "Show current NoMoreIDE runtime status.",
    execute: async () => stringify(manager.status()),
  });

  server.addTool({
    name: "nomoreide_git_status",
    description: "Show safe Git branch and porcelain status for a repository.",
    parameters: gitCwdSchema,
    execute: async ({ cwd }) => stringify(await git(cwd).status()),
  });

  server.addTool({
    name: "nomoreide_git_diff",
    description: "Show unstaged Git diff for a repository or file.",
    parameters: gitPathSchema,
    execute: async ({ cwd, path }) => await git(cwd).diff(path),
  });

  server.addTool({
    name: "nomoreide_git_branches",
    description: "List local and remote Git branches for a repository.",
    parameters: gitCwdSchema,
    execute: async ({ cwd }) => stringify(await git(cwd).branches()),
  });

  server.addTool({
    name: "nomoreide_git_switch_branch",
    description: "Switch to a local branch, or track a remote branch.",
    parameters: gitBranchSchema,
    execute: async ({ cwd, name }) => await git(cwd).switchBranch(name),
  });

  server.addTool({
    name: "nomoreide_git_create_branch",
    description: "Create and switch to a new Git branch.",
    parameters: gitBranchSchema,
    execute: async ({ cwd, name }) => await git(cwd).createBranch(name),
  });

  server.addTool({
    name: "nomoreide_git_fetch",
    description: "Fetch and prune remote Git refs for a repository.",
    parameters: gitCwdSchema,
    execute: async ({ cwd }) => await git(cwd).fetch(),
  });

  server.addTool({
    name: "nomoreide_git_staged_diff",
    description: "Show staged Git diff for a repository or file.",
    parameters: gitPathSchema,
    execute: async ({ cwd, path }) => await git(cwd).stagedDiff(path),
  });

  server.addTool({
    name: "nomoreide_git_log",
    description: "Show recent Git commits.",
    parameters: gitCwdSchema.extend({
      limit: z.number().int().positive().max(50).optional(),
    }),
    execute: async ({ cwd, limit }) => stringify(await git(cwd).log(limit)),
  });

  server.addTool({
    name: "nomoreide_git_stage",
    description: "Stage explicit file paths.",
    parameters: gitPathsSchema,
    execute: async ({ cwd, paths }) => stringify(await git(cwd).stage(paths)),
  });

  server.addTool({
    name: "nomoreide_git_unstage",
    description: "Unstage explicit file paths.",
    parameters: gitPathsSchema,
    execute: async ({ cwd, paths }) => stringify(await git(cwd).unstage(paths)),
  });

  server.addTool({
    name: "nomoreide_git_commit",
    description: "Create a Git commit from currently staged changes.",
    parameters: gitCwdSchema.extend({
      message: z.string().min(1),
    }),
    execute: async ({ cwd, message }) => await git(cwd).commit(message),
  });

  server.addTool({
    name: "nomoreide_git_register_repository",
    description: "Register a named Git repository folder for NoMoreIDE.",
    parameters: z.object({
      name: z.string().min(1),
      path: z.string().min(1),
    }),
    execute: async (args) =>
      stringify(await configStore.registerGitRepository(args)),
  });

  server.addTool({
    name: "nomoreide_git_select_repository",
    description: "Select the registered Git repository shown by NoMoreIDE.",
    parameters: z.object({
      name: z.string().min(1),
    }),
    execute: async ({ name }) =>
      stringify(await configStore.selectGitRepository(name)),
  });

  server.addTool({
    name: "nomoreide_open_ui",
    description: "Open or reuse the singleton NoMoreIDE web UI.",
    execute: async () => stringify(await uiLifecycle.ensureStarted()),
  });

  server.addTool({
    name: "nomoreide_close_ui",
    description: "Close the NoMoreIDE web UI owned by this MCP process.",
    execute: async () => stringify(await uiLifecycle.close()),
  });

  return {
    server,
    configStore,
    logStore,
    manager,
    uiLifecycle,
    toolNames: NOMOREIDE_TOOL_NAMES,
  };
}

function git(cwd?: string): GitManager {
  return new GitManager(cwd ?? process.cwd());
}

export async function startNoMoreIdeMcpServer(
  options: StartNoMoreIdeMcpServerOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const { server, uiLifecycle } = options.createServer?.() ?? createNoMoreIdeMcpServer();
  if (env.NOMOREIDE_AUTO_UI !== "0") {
    try {
      await uiLifecycle.ensureStarted();
    } catch (error) {
      process.stderr.write(
        `nomoreide: UI auto-start failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  await server.start({ transportType: "stdio" });
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
