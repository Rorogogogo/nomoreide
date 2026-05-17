import { resolve } from "node:path";
import { FastMCP } from "fastmcp";
import { ConfigStore } from "../core/config-store.js";
import { LogStore } from "../core/log-store.js";
import { ProcessManager } from "../core/process-manager.js";
import {
  createUiLifecycleManager,
  type UiLifecycleManager,
} from "../web/ui-lifecycle.js";
import {
  NOMOREIDE_TOOL_NAMES,
  registerNoMoreIdeTools,
} from "./tools.js";

export { NOMOREIDE_TOOL_NAMES } from "./tools.js";

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
  registerNoMoreIdeTools({
    server,
    configStore,
    logStore,
    manager,
    uiLifecycle,
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
