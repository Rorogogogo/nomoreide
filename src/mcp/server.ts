import { dirname, resolve } from "node:path";
import { FastMCP } from "fastmcp";
import {
  AgentSessionStore,
  createAgentSessionTracker,
} from "../core/agent-sessions.js";
import { ConfigStore, defaultGlobalConfigPath } from "../core/config-store.js";
import {
  createDaemonConnection,
  type DaemonConnection,
} from "../core/daemon-client.js";
import { DbPeek } from "../core/db-peek.js";
import { ErrorInbox } from "../core/error-inbox.js";
import { LogStore } from "../core/log-store.js";
import { ToolCallStore } from "../core/tool-call-store.js";
import {
  NOMOREIDE_TOOL_NAMES,
  registerNoMoreIdeTools,
} from "./tools/index.js";

export { NOMOREIDE_TOOL_NAMES } from "./tools/index.js";

interface CreateNoMoreIdeMcpServerOptions {
  configPath?: string;
  logDir?: string;
  /** Injectable daemon handle for tests; defaults to the global daemon. */
  daemon?: DaemonConnection;
  daemonPort?: number;
}

export interface NoMoreIdeMcpServer {
  server: FastMCP;
  configStore: ConfigStore;
  daemon: DaemonConnection;
  errorInbox: ErrorInbox;
  logStore: LogStore;
  toolCallStore: ToolCallStore;
  toolNames: typeof NOMOREIDE_TOOL_NAMES;
}

interface StartNoMoreIdeMcpServerOptions {
  env?: NodeJS.ProcessEnv;
  createServer?: () => Pick<NoMoreIdeMcpServer, "server" | "daemon">;
}

/**
 * The MCP process is a thin client: service operations go to the shared
 * daemon over HTTP; config, git, db, and agent tooling stay local because
 * they work on global config and files rather than running processes.
 */
export function createNoMoreIdeMcpServer(
  options: CreateNoMoreIdeMcpServerOptions = {},
): NoMoreIdeMcpServer {
  const configPath = options.configPath ?? defaultGlobalConfigPath();
  const logDir = options.logDir ?? resolve(process.cwd(), ".nomoreide/logs");
  const configStore = new ConfigStore(
    configPath,
  );
  const logStore = new LogStore({
    baseDir: logDir,
  });
  const daemon =
    options.daemon ?? createDaemonConnection({ port: options.daemonPort });
  const errorInbox = new ErrorInbox({ logStore, configStore });
  const dbPeek = new DbPeek({ configStore });
  const toolCallStore = new ToolCallStore();
  const agentSessions = createAgentSessionTracker({
    store: new AgentSessionStore(
      resolve(dirname(resolve(logDir)), "agent-sessions.json"),
    ),
    configStore,
  });
  const server = new FastMCP({
    name: "NoMoreIDE MCP",
    version: "0.1.0",
  });
  registerNoMoreIdeTools({
    server,
    configStore,
    daemon,
    dbPeek,
    errorInbox,
    toolCallStore,
    agentSessions,
  });

  return {
    server,
    configStore,
    daemon,
    errorInbox,
    logStore,
    toolCallStore,
    toolNames: NOMOREIDE_TOOL_NAMES,
  };
}

export async function startNoMoreIdeMcpServer(
  options: StartNoMoreIdeMcpServerOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const created = options.createServer?.() ?? createNoMoreIdeMcpServer();
  const { server, daemon } = created;
  if (env.NOMOREIDE_AUTO_UI !== "0") {
    try {
      const result = await daemon.ensure();
      if (result.versionWarning) {
        process.stderr.write(`nomoreide: ${result.versionWarning}\n`);
      }
    } catch (error) {
      process.stderr.write(
        `nomoreide: daemon auto-start failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  await server.start({ transportType: "stdio" });
}
