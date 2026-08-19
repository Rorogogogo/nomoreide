import { spawn } from "node:child_process";
import { entriesFromLines, envFilePath, readEnvFile } from "../core/env-file.js";
import { isPortAvailable } from "../core/port-utils.js";

export interface ServiceTestResult {
  ok: boolean;
  message: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string[];
  stderr: string[];
}

export async function testServiceCommand({
  command,
  cwd,
  args,
  env,
  port,
  timeoutMs = 2500,
}: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd: string;
  port?: number;
  timeoutMs?: number;
}): Promise<ServiceTestResult> {
  if (port && !(await isPortAvailable(port))) {
    return {
      ok: false,
      message: `Port ${port} is already in use.`,
      stderr: [],
      stdout: [],
    };
  }

  const stdout: string[] = [];
  const stderr: string[] = [];
  const envFile = await readEnvFile(envFilePath(cwd));
  const fileEnv = envFile.exists
    ? Object.fromEntries(entriesFromLines(envFile.lines).map((entry) => [entry.key, entry.value]))
    : {};
  const child = spawn(command, args ?? [], {
    cwd,
    detached: process.platform !== "win32",
    env: { ...process.env, ...fileEnv, ...env },
    shell: args === undefined,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer | string) => {
    appendLines(stdout, chunk.toString());
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    appendLines(stderr, chunk.toString());
  });

  return new Promise<ServiceTestResult>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      void resolveLongRunningCommand();
    }, timeoutMs);

    async function resolveLongRunningCommand() {
      if (settled) return;
      settled = true;
      const portOpened = port ? !(await isPortAvailable(port)) : undefined;
      terminateChild(child.pid);
      resolve({
        ok: port ? Boolean(portOpened) : true,
        message: port
          ? portOpened
            ? `Command started and opened port ${port}.`
            : `Command stayed running, but port ${port} did not open.`
          : "Command stayed running long enough to test startup.",
        stdout,
        stderr,
      });
    }

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        message: error.message,
        exitCode: 1,
        signal: null,
        stdout,
        stderr,
      });
    });

    child.once("exit", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: exitCode === 0,
        message:
          exitCode === 0
            ? "Command completed successfully."
            : `Command exited with code ${exitCode ?? signal ?? "unknown"}.`,
        exitCode,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

function terminateChild(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, "SIGTERM");
      return;
    }
    process.kill(pid, "SIGTERM");
  } catch {
    // The process may have exited after the timeout handler started.
  }
}

function appendLines(target: string[], text: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) {
      target.push(line);
    }
  }
}
