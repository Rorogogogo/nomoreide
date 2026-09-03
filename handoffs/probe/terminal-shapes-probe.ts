/**
 * Probe: the exact JSON a session renders as in each state the daemon can put
 * it in — running, exited, spawn-failed — and for each kind.
 */
import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { referenceSpec, RuntimeHarness } from "../../test/support/runtime-parity.js";

const root = await mkdtemp(join(tmpdir(), "nmi-terminal-shapes-"));
const harness = new RuntimeHarness(root);

const runtime = await harness.provision(
  referenceSpec(),
  (rt) => ({
    version: 1,
    services: [
      { name: "local-with-env", kind: "local", command: "true", cwd: rt.workspace, env: { Z_LAST: "z", A_FIRST: "a" } },
      { name: "needs encoding#hash", kind: "local", command: "true", cwd: rt.workspace },
      { name: "remote", kind: "ssh", command: "true", cwd: "/srv/app", host: "build-host" },
      { name: "composed", kind: "docker-compose", command: "true", cwd: rt.workspace, composeService: "web" },
    ],
    bundles: [],
    gitRepositories: [],
  }),
  () => [],
);
await harness.startDaemon(runtime);

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) }; }
  catch { return { status: response.status, body: text }; }
}

const show = (name: string, value: unknown) =>
  console.log(`\n=== ${name} ===\n${JSON.stringify(value, null, 2)}`);

// An agent session whose binary exits immediately.
const stubDir = join(runtime.home, "stub");
await mkdir(stubDir, { recursive: true });
const quitter = join(stubDir, "codex");
await writeFile(quitter, "#!/bin/sh\nexit 7\n");
await chmod(quitter, 0o755);

show("shell", await api("POST", "/api/terminal/sessions", {}));
show("service/plain", await api("POST", "/api/terminal/sessions", { serviceName: "local-with-env" }));
show("service/needs-encoding", await api("POST", "/api/terminal/sessions", { serviceName: "needs encoding#hash" }));
show("service/ssh", await api("POST", "/api/terminal/sessions", { serviceName: "remote" }));
show("service/compose", await api("POST", "/api/terminal/sessions", { serviceName: "composed" }));
show("service/unknown", await api("POST", "/api/terminal/sessions", { serviceName: "nope" }));
show("service/reopen-same-id", await api("POST", "/api/terminal/sessions", { serviceName: "local-with-env" }));

show("list", await api("GET", "/api/terminal/sessions"));

// Re-run the daemon's agent path with the stub on PATH.
console.log("\n(agent session needs NOMOREIDE_CODEX_BIN on the daemon; restarting)");
await harness.shutdown();

const second = await harness.provision(
  referenceSpec(),
  () => ({ version: 1, services: [], bundles: [], gitRepositories: [] }),
  () => [],
);
await harness.startDaemon(second, { NOMOREIDE_CODEX_BIN: quitter });
const api2 = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`http://127.0.0.1:${second.port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) }; }
  catch { return { status: response.status, body: text }; }
};
show("agent/created", await api2("POST", "/api/terminal/sessions", { agent: { provider: "codex", prompt: "hello" } }));
await new Promise((resolve) => setTimeout(resolve, 1500));
show("agent/after-exit", await api2("GET", "/api/terminal/sessions"));
show("agent/bad-provider", await api2("POST", "/api/terminal/sessions", { agent: { provider: "nope", prompt: "" } }));
show("agent/bad-resume", await api2("POST", "/api/terminal/sessions", { agent: { provider: "codex", prompt: "", resumeId: "zz" } }));

await harness.shutdown();
await rm(root, { recursive: true, force: true });
