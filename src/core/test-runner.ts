import { type ChildProcess, spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { ConfigStore } from "./config-store.js";
import type { LogStore } from "./log-store.js";
import type { LogStream } from "./types.js";

export type TestRunStatus = "running" | "passed" | "failed" | "error";

export interface TestRun {
  id: number;
  service: string;
  command: string;
  pattern?: string;
  status: TestRunStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  /** Failing test count parsed from the runner output (best-effort). */
  failingCount: number;
}

export interface TestRunEvent {
  type: "output" | "status";
  run: TestRun;
  /** Present on `output` events. */
  line?: { stream: LogStream; text: string };
}

type RunListener = (event: TestRunEvent) => void;

interface TestRunnerOptions {
  logStore: LogStore;
  configStore: ConfigStore;
  /** Workspace root used when a service has no own cwd. */
  cwd?: string;
}

const DEFAULT_TEST_COMMAND = "npm test";

/** The log channel a service's test output is appended under. */
export function testChannel(service: string): string {
  return `${service}:test`;
}

/**
 * Runs a service's test command, streaming output into {@link LogStore} under a
 * synthetic `<service>:test` channel so the {@link ErrorInbox} (which subscribes
 * to the log store) turns assertion failures and stack traces into incidents.
 * On a non-zero exit it appends a synthetic summary line so every failed run
 * also surfaces a top-level incident.
 */
export class TestRunner {
  private readonly logStore: LogStore;
  private readonly configStore: ConfigStore;
  private readonly cwd: string;

  private readonly runs = new Map<string, TestRun>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly listeners = new Map<string, Set<RunListener>>();
  private nextId = 1;
  /** Serialises log appends so the ErrorInbox sees lines in order. */
  private appendChain: Promise<unknown> = Promise.resolve();

  constructor(options: TestRunnerOptions) {
    this.logStore = options.logStore;
    this.configStore = options.configStore;
    this.cwd = options.cwd ?? process.cwd();
  }

  isRunning(service: string): boolean {
    return this.runs.get(service)?.status === "running";
  }

  /** The current or most recent run for a service. */
  current(service: string): TestRun | undefined {
    return this.runs.get(service);
  }

  subscribe(service: string, listener: RunListener): () => void {
    let set = this.listeners.get(service);
    if (!set) {
      set = new Set();
      this.listeners.set(service, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  /** Spawn the test command for a service. Rejects if a run is already active. */
  async run(service: string, pattern?: string): Promise<TestRun> {
    if (this.isRunning(service)) {
      throw new Error(`A test run is already in progress for ${service}.`);
    }

    const { command, cwd } = await this.resolveCommand(service, pattern);
    const run: TestRun = {
      id: this.nextId++,
      service,
      command,
      pattern: pattern || undefined,
      status: "running",
      startedAt: new Date().toISOString(),
      failingCount: 0,
    };
    this.runs.set(service, run);
    this.emit(service, { type: "status", run });

    const child = spawn(command, {
      cwd,
      detached: process.platform !== "win32",
      env: process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.set(service, child);

    const buffers: Record<LogStream, string> = { stdout: "", stderr: "" };
    const onChunk = (stream: LogStream) => (chunk: Buffer | string) => {
      buffers[stream] += chunk.toString();
      const lines = buffers[stream].split(/\r?\n/);
      buffers[stream] = lines.pop() ?? "";
      for (const line of lines) this.handleLine(service, run, stream, line);
    };
    child.stdout?.on("data", onChunk("stdout"));
    child.stderr?.on("data", onChunk("stderr"));

    child.once("error", (error) => {
      this.flush(service, run, buffers);
      this.finish(service, run, { status: "error", message: error.message });
    });
    child.once("exit", (exitCode, signal) => {
      this.flush(service, run, buffers);
      run.exitCode = exitCode;
      if (exitCode === 0) {
        this.finish(service, run, { status: "passed" });
      } else {
        const detail = run.failingCount ? `${run.failingCount} failing` : "non-zero exit";
        this.finish(service, run, {
          status: "failed",
          message: `ERROR: ${service} tests failed (${detail}) — exit ${exitCode ?? signal ?? "?"} — ${command}`,
        });
      }
    });

    return run;
  }

  /** Terminate the active run for a service, if any. */
  stop(service: string): void {
    const child = this.children.get(service);
    if (!child?.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else process.kill(child.pid, "SIGTERM");
    } catch {
      // The process may already have exited.
    }
  }

  private handleLine(
    service: string,
    run: TestRun,
    stream: LogStream,
    text: string,
  ): void {
    if (!text.trim()) return;
    countFailures(run, text);
    this.append(service, stream, text);
    this.emit(service, { type: "output", run, line: { stream, text } });
  }

  private flush(service: string, run: TestRun, buffers: Record<LogStream, string>): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const remaining = buffers[stream];
      buffers[stream] = "";
      if (remaining.trim()) this.handleLine(service, run, stream, remaining);
    }
  }

  private finish(
    service: string,
    run: TestRun,
    result: { status: TestRunStatus; message?: string },
  ): void {
    if (result.message) this.append(service, "stderr", result.message);
    run.status = result.status;
    run.endedAt = new Date().toISOString();
    this.children.delete(service);
    this.emit(service, { type: "status", run });
  }

  /** Append to the synthetic test channel, preserving order for the ErrorInbox. */
  private append(service: string, stream: LogStream, text: string): void {
    const channel = testChannel(service);
    this.appendChain = this.appendChain
      .then(() => this.logStore.append(channel, stream, text))
      .catch(() => {});
  }

  private emit(service: string, event: TestRunEvent): void {
    const set = this.listeners.get(service);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // ignore listener errors
      }
    }
  }

  private async resolveCommand(
    service: string,
    pattern?: string,
  ): Promise<{ command: string; cwd: string }> {
    let command = DEFAULT_TEST_COMMAND;
    let serviceCwd = this.cwd;
    try {
      const config = await this.configStore.load();
      const definition = config.services.find((item) => item.name === service);
      if (!definition) throw new Error(`Service ${service} is not registered.`);
      command = definition.test?.trim() || DEFAULT_TEST_COMMAND;
      if (definition.cwd) {
        serviceCwd = isAbsolute(definition.cwd)
          ? definition.cwd
          : resolve(this.cwd, definition.cwd);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("not registered")) throw error;
      // Otherwise fall back to defaults rooted at the workspace.
    }
    if (pattern?.trim()) command = `${command} ${pattern.trim()}`;
    return { command, cwd: serviceCwd };
  }
}

const FAIL_LINE = /^\s*(?:FAIL|✗|×)\s/;
const SUMMARY_FAILED = /(\d+)\s+failed/i;

function countFailures(run: TestRun, text: string): void {
  const summary = SUMMARY_FAILED.exec(text);
  if (summary) {
    run.failingCount = Math.max(run.failingCount, Number(summary[1]));
    return;
  }
  if (FAIL_LINE.test(text)) run.failingCount += 1;
}
