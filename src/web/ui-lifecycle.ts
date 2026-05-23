import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ToolCallStore } from "../core/tool-call-store.js";
import { createWebServer, type RunningWebServer, type WebServerOptions } from "./server.js";

export interface UiLifecycleState {
  pid: number;
  url: string;
  port: number;
  startedAt: string;
}

export interface UiLifecycleResult {
  status: "already_running" | "started";
  url: string;
  port: number;
  pid: number;
}

export interface UiLifecycleCloseResult {
  status: "stopped" | "not_running" | "not_owned";
  url?: string;
}

export interface UiLifecycleManager {
  ensureStarted(): Promise<UiLifecycleResult>;
  close(): Promise<UiLifecycleCloseResult>;
}

export interface UiLifecycleOptions extends WebServerOptions {
  statePath?: string;
  createServer?: (options: WebServerOptions) => ReturnType<typeof createWebServer>;
  fetch?: typeof fetch;
  pid?: number;
  toolCallStore?: ToolCallStore;
}

export function createUiLifecycleManager(
  options: UiLifecycleOptions = {},
): UiLifecycleManager {
  const cwd = options.cwd ?? process.cwd();
  const statePath = options.statePath ?? resolve(cwd, ".nomoreide/ui-state.json");
  const createServer = options.createServer ?? createWebServer;
  const fetchFn = options.fetch ?? fetch;
  const pid = options.pid ?? process.pid;
  const port = options.port ?? 4317;
  let ownedServer: RunningWebServer | null = null;

  return {
    async ensureStarted(): Promise<UiLifecycleResult> {
      if (ownedServer) {
        return {
          status: "already_running",
          url: ownedServer.url,
          port: ownedServer.port,
          pid,
        };
      }

      const state = await readState(statePath);
      if (state && isPidAlive(state.pid) && (await isHealthyUi(state.url, fetchFn))) {
        return {
          status: "already_running",
          url: state.url,
          port: state.port,
          pid: state.pid,
        };
      }

      if (state) {
        await removeState(statePath);
      }

      const configuredUrl = urlFromPort(port);
      if (configuredUrl && (await isHealthyUi(configuredUrl, fetchFn))) {
        return {
          status: "already_running",
          url: configuredUrl,
          port,
          pid: 0,
        };
      }

      ownedServer = await createServer({
        configPath: options.configPath,
        cwd,
        logDir: options.logDir,
        port,
        toolCallStore: options.toolCallStore,
      }).start();
      await writeState(statePath, {
        pid,
        url: ownedServer.url,
        port: ownedServer.port,
        startedAt: new Date().toISOString(),
      });

      return {
        status: "started",
        url: ownedServer.url,
        port: ownedServer.port,
        pid,
      };
    },

    async close(): Promise<UiLifecycleCloseResult> {
      if (ownedServer) {
        await ownedServer.stop();
        ownedServer = null;
        await removeState(statePath);
        return { status: "stopped" };
      }

      const state = await readState(statePath);
      if (state && isPidAlive(state.pid) && (await isHealthyUi(state.url, fetchFn))) {
        return { status: "not_owned", url: state.url };
      }

      if (state) {
        await removeState(statePath);
      }
      return { status: "not_running" };
    },
  };
}

async function readState(statePath: string): Promise<UiLifecycleState | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as UiLifecycleState;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.url !== "string" ||
      typeof parsed.port !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeState(statePath: string, state: UiLifecycleState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function removeState(statePath: string): Promise<void> {
  await rm(statePath, { force: true });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isHealthyUi(url: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchFn(new URL("/api/health", url));
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: unknown; app?: unknown };
    return body.ok === true && body.app === "nomoreide";
  } catch {
    return false;
  }
}

function urlFromPort(port: number | undefined): string | null {
  if (!port || port <= 0) {
    return null;
  }
  return `http://127.0.0.1:${port}`;
}
