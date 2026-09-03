/** Does a GET on a POST-only route answer the same in both runtimes? */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
} from "../../test/support/runtime-parity.js";

const root = await mkdtemp(join(tmpdir(), "nmi-method-probe-"));
const harness = new RuntimeHarness(root);
const config = () => ({ version: 1, services: [], bundles: [], gitRepositories: [] });

const runtimes = [];
for (const spec of [referenceSpec(), candidateSpec([process.argv[2]])]) {
  const runtime = await harness.provision(spec, config, () => []);
  await harness.startDaemon(runtime);
  runtimes.push(runtime);
}

const paths = [
  ["exact POST route", "/api/terminal/sessions/xyz/reclaim-dock"],
  ["pattern-ish", "/api/terminal/sessions/xyz/open-system-terminal"],
  ["unknown api path", "/api/definitely/not/a/route"],
  ["exact GET route", "/api/terminal/capabilities"],
  ["exact POST (approval)", "/api/agent/chat/approval"],
];

for (const runtime of runtimes) {
  const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((v) => v.trim())
    .catch(() => "");
  console.log(`\n# ${runtime.label}`);
  for (const [name, path] of paths) {
    for (const method of ["GET", "POST"]) {
      const res = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
        method,
        headers: credential ? { authorization: `Bearer ${credential}` } : {},
      });
      const text = (await res.text()).slice(0, 80);
      console.log(`  ${method.padEnd(4)} ${name.padEnd(18)} -> ${res.status} ${res.headers.get("content-type") ?? ""} ${JSON.stringify(text)}`);
    }
  }
}

await harness.shutdown();
await rm(root, { recursive: true, force: true });
