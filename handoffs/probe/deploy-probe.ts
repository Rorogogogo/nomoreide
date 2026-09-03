/** Probe: which endpoints do the four deploy tools reach, and what comes back? */
import { callMcpTool } from "../../test/support/mcp-contract.js";
import { mcpCommand, prepareRuntime, type FixtureTree } from "../../scripts/support/mcp-parity-fixture.js";
import { startApiStub, type StubRoute } from "../../scripts/support/http-api-stub.js";

const routes: StubRoute[] = JSON.parse(process.env.PROBE_ROUTES ?? "[]");

const fixture: FixtureTree & { config: Record<string, unknown> } = {
  repositories: [
    {
      id: "app",
      initialBranch: "main",
      setup: [
        { commit: { file: "README.md", contents: "# app\n", message: "init" } },
        { originUrl: "https://github.com/acme/app.git" },
      ],
    },
  ],
  config: {
    version: 1,
    services: [],
    bundles: [],
    databases: [],
    gitRepositories: [{ name: "app", path: "{{repo:app}}" }],
    selectedGitRepository: "app",
    connections: {
      vercel: { source: "stored", token: "vercel-fixture-token" },
      cloudflare: { source: "stored", token: "cloudflare-fixture-token" },
    },
  },
};

if (process.env.PROBE_CONFIG) {
  Object.assign(fixture.config, JSON.parse(process.env.PROBE_CONFIG));
}

const roots: string[] = [];
const runtime = await prepareRuntime(
  { label: "probe", command: process.execPath, args: ["--import", "tsx", "src/index.ts"] },
  fixture,
  roots,
);
const stub = await startApiStub(routes);
runtime.env.NOMOREIDE_VERCEL_API_BASE = stub.base;
runtime.env.NOMOREIDE_CLOUDFLARE_API_BASE = stub.base;

const plan: Array<{ id: string; tool: string; arguments: Record<string, unknown> }> = JSON.parse(
  process.env.PROBE_PLAN ?? "[]",
);

for (const step of plan) {
  stub.take();
  const response = await callMcpTool(mcpCommand(runtime), step.tool, step.arguments);
  const requests = stub.take();
  console.log(`\n===== ${step.id} (${step.tool} ${JSON.stringify(step.arguments)})`);
  console.log("--- requests");
  for (const request of requests) {
    console.log(`${request.method} ${request.path}  matched=${request.matched} auth=${request.authorization}`);
  }
  console.log("--- response");
  const result = (response as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown }).result;
  const text = result?.content?.[0]?.text;
  if (typeof text === "string") {
    console.log(`isError=${result?.isError ?? false}`);
    console.log(text);
  } else {
    console.log(JSON.stringify(response, null, 2));
  }
}

await stub.close();
