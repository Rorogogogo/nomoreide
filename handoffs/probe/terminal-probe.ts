/**
 * Probe: how the reference answers the three terminal MCP tools, and what a
 * terminal session actually is. Reads nothing of the implementation — boots the
 * reference daemon in a throwaway home and asks it.
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
  toolPayload,
} from "../../test/support/runtime-parity.js";

const root = await mkdtemp(join(tmpdir(), "nmi-terminal-probe-"));
const harness = new RuntimeHarness(root);

const spec = process.env.NMI_CANDIDATE
  ? candidateSpec([process.env.NMI_CANDIDATE])
  : referenceSpec();
const runtime = await harness.provision(
  spec,
  () => ({ version: 1, services: [], bundles: [], gitRepositories: [] }),
  () => [],
);
await harness.startDaemon(runtime);

async function daemonCredential(): Promise<string | undefined> {
  const statePath = join(runtime.home, ".nomoreide", "daemon.json");
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    console.log("--- daemon.json ---");
    console.log(inspect(state, { depth: null }));
    try {
      return (await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")).trim();
    } catch {
      return undefined;
    }
  } catch (error) {
    console.log("no daemon.json:", String(error));
    return undefined;
  }
}

const token = await daemonCredential();

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: response.status, body: parsed };
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const raw = await harness.call(runtime, name, args);
  return raw;
}

console.log("\n=== capabilities ===");
console.log(inspect(await api("GET", "/api/terminal/capabilities"), { depth: null }));

console.log("\n=== list (empty) via HTTP ===");
console.log(inspect(await api("GET", "/api/terminal/sessions"), { depth: null }));

console.log("\n=== list (empty) via MCP ===");
console.log(inspect(await tool("nomoreide_list_terminal_sessions"), { depth: null }));

console.log("\n=== open unknown id via MCP ===");
console.log(inspect(await tool("nomoreide_open_terminal", { id: "nope" }), { depth: null }));

console.log("\n=== reclaim unknown id via MCP ===");
console.log(inspect(await tool("nomoreide_reclaim_terminal", { id: "nope" }), { depth: null }));

console.log("\n=== create a shell session via HTTP ===");
const created = await api("POST", "/api/terminal/sessions", {});
console.log(inspect(created, { depth: null }));

console.log("\n=== list after create via MCP ===");
console.log(inspect(await tool("nomoreide_list_terminal_sessions"), { depth: null }));

const createdId = (created.body as any)?.session?.id;
if (createdId) {
  console.log("\n=== open created via MCP ===");
  console.log(inspect(await tool("nomoreide_open_terminal", { id: createdId }), { depth: null }));
  console.log("\n=== reclaim created via MCP ===");
  console.log(inspect(await tool("nomoreide_reclaim_terminal", { id: createdId }), { depth: null }));
  console.log("\n=== list after open/reclaim via MCP ===");
  console.log(inspect(await tool("nomoreide_list_terminal_sessions"), { depth: null }));
}

console.log("\n=== validation: empty id ===");
console.log(inspect(await tool("nomoreide_open_terminal", { id: "" }), { depth: null }));
console.log("\n=== validation: slash id ===");
console.log(inspect(await tool("nomoreide_open_terminal", { id: "a/b" }), { depth: null }));
console.log("\n=== validation: missing id ===");
console.log(inspect(await tool("nomoreide_open_terminal", {}), { depth: null }));
console.log("\n=== validation: extra key ===");
console.log(inspect(await tool("nomoreide_list_terminal_sessions", { unexpected: 1 }), { depth: null }));

await harness.shutdown();
await rm(root, { recursive: true, force: true });
