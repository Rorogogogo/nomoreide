/**
 * Phase 6 parity gate for the JetBrains project importer:
 *
 *   POST /api/import/jetbrains/scan
 *   POST /api/import/jetbrains/apply
 *
 * The two are **one flow**: `scan` parses a project's `.idea` and hands back a
 * preview plus a session id; `apply` spends that id. So the apply cases here
 * scan first and use each runtime's own id — the ids are UUIDs and never
 * match across runtimes, which is also why the preview compares them scrubbed.
 *
 * The fixtures are real `.idea` files, and each one is there for a reason:
 * a supported run configuration, one whose type nothing maps, a `.run/*.run.xml`
 * and a `.run/*.xml` that must be ignored beside it, a personal `workspace.xml`
 * that only `includePersonal` reaches, a `dataSources.xml`, and a file carrying
 * a DTD — which must be refused rather than parsed, because an entity
 * declaration in someone else's project file is an XXE waiting to happen.
 *
 * Usage:
 *   node --import tsx scripts/check-jetbrains-parity.ts <candidate> [args...]
 *   ... --dump    print both payloads per step
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  candidateSpec,
  referenceSpec,
  RuntimeHarness,
  type Runtime,
} from "../test/support/runtime-parity.js";

const argv = process.argv.slice(2).filter((a) => a !== "--dump");
const dump = process.argv.slice(2).includes("--dump");
if (argv.length === 0) {
  throw new Error("Usage: node --import tsx scripts/check-jetbrains-parity.ts [--dump] <candidate> [args...]");
}

const credentials = new Map<Runtime, string>();
const auth = (runtime: Runtime): Record<string, string> => {
  const credential = credentials.get(runtime) ?? "";
  return credential ? { authorization: `Bearer ${credential}` } : {};
};

interface Answer {
  status: number;
  contentType: string | null;
  body: unknown;
}

async function post(runtime: Runtime, path: string, body: unknown): Promise<Answer> {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
    method: "POST",
    headers: { ...auth(runtime), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* compared as the text it was */
  }
  return { status: response.status, contentType: response.headers.get("content-type"), body: parsed };
}

/** Session and candidate ids are UUIDs; the expiry is a clock. */
const VOLATILE = new Set(["sessionId", "id", "expiresAt"]);

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) =>
        VOLATILE.has(key) ? [key, "<volatile>"] : [key, scrub(item)],
      ),
    );
  }
  return value;
}

function normalize(value: unknown, runtime: Runtime): unknown {
  const erased = JSON.stringify(value ?? null)
    .split(`/private${runtime.home}`)
    .join("<home>")
    .split(runtime.home)
    .join("<home>");
  return scrub(JSON.parse(erased));
}

// --- fixtures ----------------------------------------------------------------

const runConfig = (name: string, type: string, body: string) =>
  `<component name="ProjectRunConfigurationManager">
  <configuration name="${name}" type="${type}" factoryName="Application">
${body}
  </configuration>
</component>
`;

const NPM_RUN = runConfig(
  "web dev",
  "js.build_tools.npm",
  `    <package-json value="$PROJECT_DIR$/package.json" />
    <command value="run" />
    <scripts>
      <script value="dev" />
    </scripts>
    <node-interpreter value="project" />
    <envs>
      <env name="PORT" value="3000" />
      <env name="API_TOKEN" value="secret" />
    </envs>`,
);

const SHELL_RUN = runConfig(
  "worker",
  "ShConfigurationType",
  `    <option name="SCRIPT_TEXT" value="node worker.js" />
    <option name="INDEPENDENT_SCRIPT_PATH" value="true" />
    <option name="SCRIPT_WORKING_DIRECTORY" value="$PROJECT_DIR$" />
    <option name="EXECUTE_IN_TERMINAL" value="true" />`,
);

/** A type nothing maps, so it lands in `unsupported` rather than being guessed at. */
const EXOTIC_RUN = runConfig("deploy", "AndroidRunConfigurationType", `    <option name="X" value="1" />`);

const DTD_FILE = `<!DOCTYPE component [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<component name="ProjectRunConfigurationManager">
  <configuration name="evil" type="ShConfigurationType" factoryName="Application">
    <option name="SCRIPT_TEXT" value="&xxe;" />
  </configuration>
</component>
`;

const WORKSPACE = `<project version="4">
  <component name="RunManager">
    <configuration name="personal task" type="ShConfigurationType" factoryName="Application">
      <option name="SCRIPT_TEXT" value="echo personal" />
      <option name="SCRIPT_WORKING_DIRECTORY" value="$PROJECT_DIR$" />
    </configuration>
  </component>
</project>
`;

const DATA_SOURCES = `<component name="DataSourceManagerImpl" format="xml" multifile-model="true">
  <data-source source="LOCAL" name="app db" uuid="11111111-1111-1111-1111-111111111111">
    <driver-ref>postgresql</driver-ref>
    <jdbc-driver>org.postgresql.Driver</jdbc-driver>
    <jdbc-url>jdbc:postgresql://localhost:5432/appdb</jdbc-url>
    <user-name>app</user-name>
  </data-source>
  <data-source source="LOCAL" name="mystery" uuid="22222222-2222-2222-2222-222222222222">
    <driver-ref>cassandra</driver-ref>
    <jdbc-url>jdbc:cassandra://localhost:9042/ks</jdbc-url>
  </data-source>
</component>
`;

const files = () => [
  { path: ".idea/runConfigurations/web_dev.xml", contents: NPM_RUN },
  { path: ".idea/runConfigurations/worker.xml", contents: SHELL_RUN },
  { path: ".idea/runConfigurations/deploy.xml", contents: EXOTIC_RUN },
  { path: ".idea/runConfigurations/evil.xml", contents: DTD_FILE },
  { path: ".idea/workspace.xml", contents: WORKSPACE },
  { path: ".idea/dataSources.xml", contents: DATA_SOURCES },
  // The two directories accept different names: `.run` takes only
  // `*.run.xml`, while `.idea/runConfigurations` takes any `.xml`. Both
  // fixtures are here so the asymmetry is pinned rather than assumed.
  { path: ".run/extra.run.xml", contents: runConfig("extra", "ShConfigurationType", `    <option name="SCRIPT_TEXT" value="echo extra" />`) },
  { path: ".run/ignored.xml", contents: runConfig("ignored", "ShConfigurationType", `    <option name="SCRIPT_TEXT" value="echo ignored" />`) },
  { path: "package.json", contents: '{"name":"fixture","scripts":{"dev":"vite"}}\n' },
];

const root = await mkdtemp(join(tmpdir(), "nmi-jetbrains-parity-"));
const harness = new RuntimeHarness(root);
let failures = 0;

function compare(name: string, reference: unknown, candidate: unknown): void {
  if (dump) {
    console.log(`--- ${name} ---`);
    console.log(`  reference: ${inspect(reference, { depth: null })}`);
    console.log(`  candidate: ${inspect(candidate, { depth: null })}`);
  }
  try {
    assert.deepStrictEqual(candidate, reference);
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}`);
    console.log(`  reference: ${inspect(reference, { depth: null })}`);
    console.log(`  candidate: ${inspect(candidate, { depth: null })}`);
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  const runtimes: Runtime[] = [];
  for (const spec of [referenceSpec(), candidateSpec(argv)]) {
    const runtime = await harness.provision(
      spec,
      ({ workspace }) => ({
        version: 1,
        // `worker` already exists, so one candidate previews as a conflict.
        services: [{ name: "worker", command: "true", cwd: workspace }],
        bundles: [],
        databases: [],
        gitRepositories: [],
      }),
      files,
    );
    await harness.startDaemon(runtime, {}, runtime.workspace);
    credentials.set(
      runtime,
      await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
        .then((value) => value.trim())
        .catch(() => ""),
    );
    runtimes.push(runtime);
  }
  const [reference, candidate] = runtimes;

  const both = async (name: string, path: string, body: (runtime: Runtime) => unknown) => {
    compare(
      name,
      normalize(await post(reference, path, body(reference)), reference),
      normalize(await post(candidate, path, body(candidate)), candidate),
    );
  };

  const SCAN = "/api/import/jetbrains/scan";
  const APPLY = "/api/import/jetbrains/apply";

  await both("scan/no-project-root", SCAN, () => ({}));
  await both("scan/a-blank-project-root", SCAN, () => ({ projectRoot: "   " }));
  await both("scan/a-root-that-is-not-there", SCAN, (r) => ({ projectRoot: join(r.workspace, "nope") }));
  await both("scan/a-root-that-is-a-file", SCAN, (r) => ({ projectRoot: join(r.workspace, "package.json") }));
  await both("scan/the-preview", SCAN, (r) => ({ projectRoot: r.workspace }));
  await both("scan/including-personal", SCAN, (r) => ({ projectRoot: r.workspace, includePersonal: true }));

  await both("apply/missing-fields", APPLY, () => ({}));
  await both("apply/selections-that-are-not-an-array", APPLY, () => ({ sessionId: "x", selections: "no" }));
  await both("apply/an-unknown-session", APPLY, () => ({ sessionId: "no-such-session", selections: [] }));
  await both("apply/a-selection-that-is-not-an-object", APPLY, () => ({
    sessionId: "x",
    selections: ["nope"],
  }));
  await both("apply/an-unknown-conflict-mode", APPLY, () => ({
    sessionId: "x",
    selections: [{ id: "a", conflict: "clobber" }],
  }));

  /** Scan, then apply against the ids that scan just handed this runtime. */
  async function applyAfterScan(
    name: string,
    pick: (preview: Record<string, unknown>) => unknown,
  ) {
    const answers = await Promise.all(
      runtimes.map(async (runtime) => {
        const scanned = (await post(runtime, SCAN, { projectRoot: runtime.workspace })) as {
          body: { preview?: Record<string, unknown> };
        };
        const preview = scanned.body.preview ?? {};
        return normalize(await post(runtime, APPLY, pick(preview)), runtime);
      }),
    );
    compare(name, answers[0], answers[1]);
  }

  await applyAfterScan("apply/one-service", (preview) => {
    const candidates = (preview.candidates ?? []) as Array<{ id: string; name: string }>;
    const chosen = candidates.find((entry) => entry.name === "web dev");
    return {
      sessionId: preview.sessionId,
      selections: chosen ? [{ id: chosen.id, conflict: "add" }] : [],
    };
  });

  await applyAfterScan("apply/a-conflicting-name-renamed", (preview) => {
    const candidates = (preview.candidates ?? []) as Array<{ id: string; name: string }>;
    const chosen = candidates.find((entry) => entry.name === "worker");
    return {
      sessionId: preview.sessionId,
      selections: chosen ? [{ id: chosen.id, conflict: "rename", name: "worker-imported" }] : [],
    };
  });

  await applyAfterScan("apply/an-id-that-is-not-in-the-session", (preview) => ({
    sessionId: preview.sessionId,
    selections: [{ id: "00000000-0000-0000-0000-000000000000", conflict: "add" }],
  }));

  // The config the imports landed in, read back.
  compare(
    "config/after-the-imports",
    normalize(await post(reference, "/api/config/reload", {}), reference),
    normalize(await post(candidate, "/api/config/reload", {}), candidate),
  );
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\njetbrains parity: ${failures} case(s) diverged`);
  process.exit(1);
}
console.log("\njetbrains parity: all cases match");
