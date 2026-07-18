import { rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appVersion } from "../core/app-version.js";
import { DaemonClient } from "../core/daemon-client.js";
import {
  defaultDaemonStatePath,
  ensureDaemon,
  probeDaemon,
  readDaemonState,
  resolveDaemonPort,
  type DaemonState,
} from "../core/daemon-lifecycle.js";
import { createWebServer } from "../web/server.js";

export interface DaemonCliOptions {
  statePath?: string;
  port?: number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/**
 * `nomoreide daemon [status|stop|restart] [--port=N]`.
 *
 * Bare `nomoreide daemon` runs the machine-global daemon in the foreground —
 * the process `ensureDaemon()` spawns detached. It owns every spawned service
 * and uses global state dirs (`~/.nomoreide/logs`, `~/.nomoreide`), so any
 * session on the machine sees the same services and logs.
 */
export async function runDaemonCli(
  args: string[],
  options: DaemonCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const statePath = options.statePath ?? defaultDaemonStatePath();
  const subcommand = args.find((arg) => !arg.startsWith("--"));
  const portArg = args.find((arg) => arg.startsWith("--port="));
  const port =
    options.port ??
    (portArg ? Number(portArg.slice("--port=".length)) : resolveDaemonPort());

  if (subcommand === "status") {
    return await printStatus(statePath, port, stdout);
  }
  if (subcommand === "stop") {
    return await stopDaemon(statePath, port, stdout, stderr);
  }
  if (subcommand === "restart") {
    const stopped = await stopDaemon(statePath, port, stdout, stderr);
    if (stopped !== 0) return stopped;
    const result = await ensureDaemon({ statePath, port });
    stdout(`NoMoreIDE daemon restarted: ${result.url} (pid ${result.pid})`);
    return 0;
  }
  if (subcommand !== undefined) {
    stderr("Usage: nomoreide daemon [status|stop|restart] [--port=N]");
    return 1;
  }

  return await runDaemon(statePath, port, stderr);
}

async function runDaemon(
  statePath: string,
  port: number,
  stderr: (line: string) => void,
): Promise<number> {
  const stateDir = join(homedir(), ".nomoreide");
  let server: Awaited<ReturnType<ReturnType<typeof createWebServer>["start"]>>;
  try {
    server = await createWebServer({
      logDir: join(stateDir, "logs"),
      cwd: process.cwd(),
      port,
      onDaemonShutdown: async () => {
        await rm(statePath, { force: true });
        process.exit(0);
      },
    }).start();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      // Spawn race: another daemon won the bind — exit quietly so the
      // session that spawned us adopts the winner via its health poll.
      stderr(`NoMoreIDE daemon already listening on port ${port}; exiting.`);
      return 0;
    }
    throw error;
  }

  const state: DaemonState = {
    pid: process.pid,
    url: server.url,
    port: server.port,
    version: appVersion(),
    startedAt: new Date().toISOString(),
  };
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  // ProcessManager's signal handlers stop services then re-raise; this exit
  // hook only has to clear the state file so the next ensureDaemon respawns.
  process.once("exit", () => {
    try {
      rmSync(statePath, { force: true });
    } catch {
      // Best effort — a stale file is also caught by the pid-liveness check.
    }
  });

  stderr(`NoMoreIDE daemon v${state.version}: ${server.url} (pid ${state.pid})`);
  return await new Promise<number>(() => {
    // Runs until a signal or /api/daemon/shutdown exits the process.
  });
}

async function printStatus(
  statePath: string,
  port: number,
  stdout: (line: string) => void,
): Promise<number> {
  const state = await readDaemonState(statePath);
  const url = state?.url ?? `http://127.0.0.1:${port}`;
  const probe = await probeDaemon(url);
  if (probe.kind !== "nomoreide") {
    stdout(`NoMoreIDE daemon: not running (probed ${url})`);
    return 1;
  }
  const version = probe.health.version ?? state?.version ?? "unknown";
  const pid = probe.health.pid ?? state?.pid;
  stdout(`NoMoreIDE daemon: running at ${url} (pid ${pid ?? "?"}, v${version})`);
  const client = new DaemonClient(url);
  const status = await client.status();
  const services = Object.values(status.services);
  const running = services.filter((service) => service.state === "running");
  stdout(`Services: ${running.length} running / ${services.length} known`);
  for (const service of running) {
    stdout(`  ${service.name}  pid ${service.pid ?? "?"}  ${service.url ?? ""}`);
  }
  return 0;
}

async function stopDaemon(
  statePath: string,
  port: number,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): Promise<number> {
  const state = await readDaemonState(statePath);
  const url = state?.url ?? `http://127.0.0.1:${port}`;
  const probe = await probeDaemon(url);
  if (probe.kind === "down") {
    await rm(statePath, { force: true });
    stdout("NoMoreIDE daemon is not running.");
    return 0;
  }
  if (probe.kind === "foreign") {
    stderr(`Port at ${url} is held by a non-NoMoreIDE process; not touching it.`);
    return 1;
  }

  await new DaemonClient(url).shutdown();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await probeDaemon(url)).kind === "down") {
      stdout("NoMoreIDE daemon stopped (all services shut down).");
      return 0;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
  }
  stderr("Daemon did not exit within 10s; its services may still be stopping.");
  return 1;
}
