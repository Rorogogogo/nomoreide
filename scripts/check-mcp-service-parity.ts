import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { callMcpTool, type McpCommand } from "../test/support/mcp-contract.js";
import { Recorder } from "../test/support/parity-recording.js";
import { referenceSpec } from "../test/support/runtime-parity.js";

const candidateArgs = process.argv.slice(2);
if (candidateArgs.length === 0) {
  throw new Error(
    "Usage: node --import tsx scripts/check-mcp-service-parity.ts <candidate-command> [candidate-args...]",
  );
}

const root = resolve(import.meta.dirname, "..");
const fixture = JSON.parse(
  await readFile(join(root, "test/fixtures/mcp-service-discovery-v1.json"), "utf8"),
) as {
  config: Record<string, unknown>;
  expectedDiscovery: unknown;
};
const recorder = new Recorder();
const reference_ = referenceSpec();
const referenceHome = await mkdtemp(join(tmpdir(), "nomoreide-service-reference-"));
const candidateHome = await mkdtemp(join(tmpdir(), "nomoreide-service-candidate-"));
const port = await availablePort();
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

function command(commandName: string, args: string[], home: string): McpCommand {
  return {
    command: commandName,
    args,
    cwd: root,
    env: {
      ...inheritedEnv,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      NOMOREIDE_AUTO_UI: "0",
      NOMOREIDE_DAEMON_PORT: String(port),
    },
  };
}

let daemon: ChildProcess | undefined;
let daemonReady = false;
try {
  await Promise.all(
    [referenceHome, candidateHome].map(async (home) => {
      const directory = join(home, ".config", "nomoreide");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "config.json"),
        `${JSON.stringify(fixture.config, null, 2)}\n`,
      );
    }),
  );

  const candidateBase = command(candidateArgs[0], candidateArgs.slice(1), candidateHome);
  daemon = spawn(candidateBase.command, [...candidateBase.args, "daemon"], {
    cwd: candidateBase.cwd,
    env: candidateBase.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonStderr = "";
  daemon.stderr?.setEncoding("utf8");
  daemon.stderr?.on("data", (chunk: string) => {
    daemonStderr += chunk;
  });
  await waitForDaemon(candidateHome, daemon, () => daemonStderr);
  daemonReady = true;

  // In replay this answer comes from the recording, and `reference_.command`
  // is a path that cannot exist — so a run that still tried to spawn the
  // reference would die naming itself rather than pass because `src/` happens
  // to still be here.
  const reference = await recorder.recorded(
    { ...reference_, home: referenceHome, workspace: referenceHome, port },
    "list-services",
    () =>
      callMcpTool(
        command(reference_.command, [...reference_.args, "mcp"], referenceHome),
        "nomoreide_list_services",
        {},
      ),
  );
  const native = await callMcpTool(
    command(
      candidateArgs[0],
      [...candidateArgs.slice(1), "mcp"],
      candidateHome,
    ),
    "nomoreide_list_services",
    {},
  );

  assert.deepStrictEqual(native, reference);
  const discovery = parseDiscovery(native);
  assert.deepStrictEqual(discovery, fixture.expectedDiscovery);
  assert.doesNotMatch(JSON.stringify(native), /fixture-secret-value|development/);
  process.stdout.write("MCP service discovery parity passed.\n");
} finally {
  await recorder.finish();
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await waitForExit(daemon);
  }
  if (daemonReady) {
    await assert.rejects(readFile(join(candidateHome, ".nomoreide", "daemon.json")));
    await assert.rejects(
      readFile(join(candidateHome, ".nomoreide", "daemon.credential")),
    );
  }
  await Promise.all([
    rm(referenceHome, { recursive: true, force: true }),
    rm(candidateHome, { recursive: true, force: true }),
  ]);
}

function parseDiscovery(response: Awaited<ReturnType<typeof callMcpTool>>): unknown {
  const result = response.result as
    | { content?: Array<{ type?: string; text?: string }> }
    | undefined;
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("MCP service discovery returned no text content");
  }
  return JSON.parse(text);
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a daemon test port");
  }
  const selected = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return selected;
}

async function waitForDaemon(
  home: string,
  process: ChildProcess,
  stderr: () => string,
): Promise<void> {
  const statePath = join(home, ".nomoreide", "daemon.json");
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (process.exitCode !== null) {
      throw new Error(`Native daemon exited before startup: ${stderr().trim()}`);
    }
    try {
      const state = JSON.parse(await readFile(statePath, "utf8")) as { url?: string };
      if (state.url) {
        const response = await fetch(new URL("/api/health", state.url));
        if (response.ok) return;
      }
    } catch {
      // Startup publishes state only after the listener is bound.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("Timed out waiting for the native daemon");
}

async function waitForExit(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  await new Promise<void>((resolveExit) => {
    const timeout = setTimeout(() => {
      process.kill("SIGKILL");
      resolveExit();
    }, 2_000);
    process.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}
