import { dirname, resolve } from "node:path";
import { FastMCP } from "fastmcp";
import {
  AgentSessionStore,
  createAgentSessionTracker,
} from "../core/agent-sessions.js";
import { ConfigStore, defaultGlobalConfigPath } from "../core/config-store.js";
import { DbPeek } from "../core/db-peek.js";
import { ErrorInbox } from "../core/error-inbox.js";
import { LogStore } from "../core/log-store.js";
import { ProcessManager } from "../core/process-manager.js";
import {
  defaultRuntimeRegistryPath,
  ServiceRegistry,
} from "../core/service-registry.js";
import { TimelineStore } from "../core/timeline-store.js";
import { ToolCallStore } from "../core/tool-call-store.js";
import {
  createUiLifecycleManager,
  type UiLifecycleManager,
} from "../web/ui-lifecycle.js";
import {
  NOMOREIDE_TOOL_NAMES,
  registerNoMoreIdeTools,
} from "./tools/index.js";

export { NOMOREIDE_TOOL_NAMES } from "./tools/index.js";

interface CreateNoMoreIdeMcpServerOptions {
  configPath?: string;
  logDir?: string;
  uiLifecycle?: UiLifecycleManager;
  uiPort?: number;
}

export interface NoMoreIdeMcpServer {
  server: FastMCP;
  configStore: ConfigStore;
  errorInbox: ErrorInbox;
  logStore: LogStore;
  manager: ProcessManager;
  uiLifecycle: UiLifecycleManager;
  toolCallStore: ToolCallStore;
  toolNames: typeof NOMOREIDE_TOOL_NAMES;
}

interface StartNoMoreIdeMcpServerOptions {
  env?: NodeJS.ProcessEnv;
  createServer?: () => Pick<NoMoreIdeMcpServer, "server" | "uiLifecycle">;
}

export function createNoMoreIdeMcpServer(
  options: CreateNoMoreIdeMcpServerOptions = {},
): NoMoreIdeMcpServer {
  const configPath = options.configPath ?? defaultGlobalConfigPath();
  const logDir = options.logDir ?? resolve(process.cwd(), ".nomoreide/logs");
  const configStore = new ConfigStore(
    configPath,
  );
  const timelineStore = new TimelineStore({
    baseDir: dirname(resolve(logDir)),
  });
  const logStore = new LogStore({
    baseDir: logDir,
    timelineStore,
  });
  const registry = new ServiceRegistry(defaultRuntimeRegistryPath(logDir));
  const manager = new ProcessManager({
    configStore,
    logStore,
    timelineStore,
    registry,
  });
  const errorInbox = new ErrorInbox({ logStore, configStore });
  const dbPeek = new DbPeek({ configStore });
  const toolCallStore = new ToolCallStore();
  const agentSessions = createAgentSessionTracker({
    store: new AgentSessionStore(
      resolve(dirname(resolve(logDir)), "agent-sessions.json"),
    ),
    configStore,
  });
  const uiLifecycle =
    options.uiLifecycle ??
    createUiLifecycleManager({
      configPath,
      logDir,
      port: options.uiPort,
      toolCallStore,
    });
  const server = new FastMCP({
    name: "NoMoreIDE MCP",
    version: "0.1.0",
  });
  registerNoMoreIdeTools({
    server,
    configStore,
    dbPeek,
    errorInbox,
    logStore,
    manager,
    timelineStore,
    uiLifecycle,
    toolCallStore,
    agentSessions,
  });

  return {
    server,
    configStore,
    errorInbox,
    logStore,
    manager,
    uiLifecycle,
    toolCallStore,
    toolNames: NOMOREIDE_TOOL_NAMES,
  };
}

export async function startNoMoreIdeMcpServer(
  options: StartNoMoreIdeMcpServerOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const created = options.createServer?.() ?? createNoMoreIdeMcpServer();
  const { server, uiLifecycle } = created;
  if ("manager" in created) {
    (created as NoMoreIdeMcpServer).manager.installShutdownHandlers();
  }
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
