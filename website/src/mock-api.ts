import type {
  AgentInfo,
  ColumnInfo,
  DashboardData,
  DatabaseConnection,
  ErrorIncident,
  GitGraphCommit,
  GitHubCheckRun,
  GitHubComment,
  GitHubIssue,
  GitHubPR,
  GitHubWorkflowJob,
  GitHubWorkflowRun,
  LogEntry,
  RowSample,
  ServiceStatus,
  TableRef,
  Workflow,
} from "@/lib/api";

const startedAt = new Date(Date.now() - 1000 * 60 * 18).toISOString();

let serviceStates: Record<string, ServiceStatus["state"]> = {
  "web-client": "running",
  api: "running",
  worker: "stopped",
};

const serviceDefinitions = [
  {
    name: "web-client",
    command: "npm run dev:web",
    cwd: "/Users/demo/projects/acme",
    port: 5173,
    description: "React frontend",
  },
  {
    name: "api",
    command: "pnpm dev:api",
    cwd: "/Users/demo/projects/acme/services/api",
    port: 4317,
    description: "Local API service",
  },
  {
    name: "worker",
    command: "npm run queue",
    cwd: "/Users/demo/projects/acme/services/worker",
    port: 8721,
    description: "Background job worker",
  },
];

const gitFiles = [
  { path: "src/features/billing/checkout.tsx", index: " ", workingTree: "M" },
  { path: "src/config/services.json", index: "M", workingTree: " " },
  { path: "src/web/client/src/features/services/service-detail/env-tab.tsx", index: " ", workingTree: "M" },
  { path: "src/web/client/src/features/git/diff-viewer.tsx", index: " ", workingTree: "M" },
  { path: "src/mcp/tools/services.ts", index: "M", workingTree: "M" },
  { path: "test/service-health-ui.test.tsx", index: " ", workingTree: "M" },
  { path: "website/src/components/real-product-demo.tsx", index: "A", workingTree: " " },
  { path: "src/core/config-store.ts", index: " ", workingTree: "M" },
  { path: "README.md", index: " ", workingTree: "A" },
];

const gitStatus = {
  branch: "feat/website-real-ui-demo",
  upstream: "origin/feat/website-real-ui-demo",
  ahead: 2,
  behind: 0,
  files: gitFiles,
};

const diffs: Record<string, string> = {
  "src/features/billing/checkout.tsx": `diff --git a/src/features/billing/checkout.tsx b/src/features/billing/checkout.tsx
index 1b2c3d4..5e6f778 100644
--- a/src/features/billing/checkout.tsx
+++ b/src/features/billing/checkout.tsx
@@ -12,9 +12,13 @@ export function CheckoutPanel({ plan }: Props) {
-  const secret = process.env.STRIPE_SECRET_KEY;
-  const session = createCheckoutSession(plan, secret);
+  const credential = getCredential("STRIPE_SECRET_KEY");
+  const session = createCheckoutSession({
+    plan,
+    credential,
+    mode: "demo",
+  });
 
   return <PaymentSummary session={session} />;
 }`,
  "src/config/services.json": `diff --git a/src/config/services.json b/src/config/services.json
index 88aa12b..99cc32d 100644
--- a/src/config/services.json
+++ b/src/config/services.json
@@ -1,7 +1,10 @@
 {
   "services": [
-    { "name": "api", "port": 4000 },
+    { "name": "api", "port": 4317, "envFile": ".env.local" },
+    { "name": "worker", "port": 8721, "health": "/ready" },
     { "name": "web-client", "port": 5173 }
   ]
 }`,
  "README.md": `diff --git a/README.md b/README.md
new file mode 100644
--- /dev/null
+++ b/README.md
@@ -0,0 +1,4 @@
+## Local development
+
+Run \`nomoreide\` to open the service workbench.
+Credentials in screenshots use placeholders only.`,
  "src/web/client/src/features/services/service-detail/env-tab.tsx": `diff --git a/src/web/client/src/features/services/service-detail/env-tab.tsx b/src/web/client/src/features/services/service-detail/env-tab.tsx
index 355ad90..81c72af 100644
--- a/src/web/client/src/features/services/service-detail/env-tab.tsx
+++ b/src/web/client/src/features/services/service-detail/env-tab.tsx
@@ -28,7 +28,10 @@ export function EnvTab({ service }: Props) {
   return (
     <EnvTable
       entries={entries}
-      revealSecrets={false}
+      revealSecrets={demoMode ? true : false}
+      secretPlaceholder="placeholder-only"
+      onCopy={(key) => showMessage(\`Copied \${key} from mock config\`)}
     />
   );
 }`,
  "src/web/client/src/features/git/diff-viewer.tsx": `diff --git a/src/web/client/src/features/git/diff-viewer.tsx b/src/web/client/src/features/git/diff-viewer.tsx
index 1db917a..dbf4212 100644
--- a/src/web/client/src/features/git/diff-viewer.tsx
+++ b/src/web/client/src/features/git/diff-viewer.tsx
@@ -74,6 +74,8 @@ export function DiffViewer({ diff }: Props) {
       const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "context";
       return (
         <DiffLine key={index} kind={kind}>
+          {kind === "add" && line.includes("placeholder") ? <Badge>mock</Badge> : null}
           {line}
         </DiffLine>
       );
 }`,
  "src/mcp/tools/services.ts": `diff --git a/src/mcp/tools/services.ts b/src/mcp/tools/services.ts
index 42c7fab..996413a 100644
--- a/src/mcp/tools/services.ts
+++ b/src/mcp/tools/services.ts
@@ -41,6 +41,9 @@ export function registerServiceTools(server: FastMCP, services: ToolServices) {
   server.addTool({
     name: "list_services",
     description: "List configured local services and their runtime state.",
+    annotations: {
+      readOnlyHint: true,
+    },
     execute: async () => services.dashboard(),
   });
 }`,
  "test/service-health-ui.test.tsx": `diff --git a/test/service-health-ui.test.tsx b/test/service-health-ui.test.tsx
index c3d84f2..a1c49b1 100644
--- a/test/service-health-ui.test.tsx
+++ b/test/service-health-ui.test.tsx
@@ -12,6 +12,10 @@ test("renders service health summary", () => {
   render(<HealthSummary health={health} />);
 
   expect(screen.getByText("Healthy")).toBeInTheDocument();
+  expect(screen.getByText("Mock probe")).toBeInTheDocument();
+  expect(screen.queryByText("real-secret-value")).not.toBeInTheDocument();
 });
`,
  "website/src/components/real-product-demo.tsx": `diff --git a/website/src/components/real-product-demo.tsx b/website/src/components/real-product-demo.tsx
new file mode 100644
--- /dev/null
+++ b/website/src/components/real-product-demo.tsx
@@ -0,0 +1,8 @@
+import { App as WorkbenchApp } from "@/app";
+import { installWebsiteMockApi } from "../mock-api";
+
+installWebsiteMockApi();
+
+export function RealProductDemo() {
+  return <WorkbenchApp syncLocation={false} />;
+}
`,
  "src/core/config-store.ts": `diff --git a/src/core/config-store.ts b/src/core/config-store.ts
index 182df31..e33290b 100644
--- a/src/core/config-store.ts
+++ b/src/core/config-store.ts
@@ -88,7 +88,8 @@ export const serviceSchema = z.object({
   cwd: z.string().optional(),
   port: z.number().int().positive().optional(),
   env: z.record(z.string()).optional(),
-  description: z.string().optional(),
+  description: z.string().optional(),
+  envFile: z.string().optional(),
 });
`,
};

const files: Record<string, string> = {
  "src/features/billing/checkout.tsx": `export function CheckoutPanel({ plan }: Props) {
  const credential = getCredential("STRIPE_SECRET_KEY");
  const session = createCheckoutSession({
    plan,
    credential,
    mode: "demo",
  });

  return <PaymentSummary session={session} />;
}
`,
  "src/config/services.json": JSON.stringify(
    {
      services: [
        { name: "api", port: 4317, envFile: ".env.local" },
        { name: "worker", port: 8721, health: "/ready" },
        { name: "web-client", port: 5173 },
      ],
    },
    null,
    2,
  ),
  "src/web/client/src/features/services/service-detail/env-tab.tsx": `export function EnvTab({ service }: Props) {
  return (
    <EnvTable
      entries={entries}
      revealSecrets={demoMode ? true : false}
      secretPlaceholder="placeholder-only"
      onCopy={(key) => showMessage(\`Copied \${key} from mock config\`)}
    />
  );
}
`,
  "src/web/client/src/features/git/diff-viewer.tsx": `export function DiffViewer({ diff }: Props) {
  return diff.split("\\n").map((line, index) => {
    const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "context";
    return <DiffLine key={index} kind={kind}>{line}</DiffLine>;
  });
}
`,
  "src/mcp/tools/services.ts": `export function registerServiceTools(server: FastMCP, services: ToolServices) {
  server.addTool({
    name: "list_services",
    description: "List configured local services and their runtime state.",
    annotations: { readOnlyHint: true },
    execute: async () => services.dashboard(),
  });
}
`,
  "test/service-health-ui.test.tsx": `test("renders service health summary", () => {
  render(<HealthSummary health={health} />);
  expect(screen.getByText("Healthy")).toBeInTheDocument();
  expect(screen.getByText("Mock probe")).toBeInTheDocument();
  expect(screen.queryByText("real-secret-value")).not.toBeInTheDocument();
});
`,
  "website/src/components/real-product-demo.tsx": `import { App as WorkbenchApp } from "@/app";
import { installWebsiteMockApi } from "../mock-api";

installWebsiteMockApi();

export function RealProductDemo() {
  return <WorkbenchApp syncLocation={false} />;
}
`,
  "src/core/config-store.ts": `export const serviceSchema = z.object({
  name: z.string(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  port: z.number().int().positive().optional(),
  env: z.record(z.string()).optional(),
  description: z.string().optional(),
  envFile: z.string().optional(),
});
`,
  "README.md": "## Local development\n\nRun `nomoreide` to open the service workbench.\n",
};

const incidents: ErrorIncident[] = [
  {
    id: 1,
    service: "api",
    level: "warning",
    signature: "placeholder-credential-used",
    title: "Demo credential placeholder detected",
    file: "src/config/services.json",
    line: 4,
    firstSeen: new Date(Date.now() - 1000 * 60 * 42).toISOString(),
    lastSeen: new Date(Date.now() - 1000 * 60 * 3).toISOString(),
    count: 3,
    logExcerpt: [
      "WARN using placeholder DATABASE_URL in website demo",
      "INFO replace placeholders before connecting a real backend",
    ],
  },
];

let terminalSessions = [
  {
    id: "demo-terminal",
    cwd: "/Users/demo/projects/acme",
    cols: 100,
    rows: 28,
    shell: "zsh",
    state: "running" as const,
    label: "demo shell",
  },
];

let databaseWriteUnlocked = false;

const workflows: Workflow[] = [
  {
    id: "commit-push",
    name: "Commit & push",
    description: "Pause for approval, make one AI-written commit, then push the branch.",
    builtin: true,
    steps: [
      {
        kind: "gate",
        id: "gate-commit",
        title: "Approve commit",
        message: "Stage the current changes and create one AI-written commit?",
      },
      {
        kind: "agent",
        id: "commit",
        title: "Commit all changes",
        prompt: "Stage reviewed files, inspect the staged diff, and create one conventional commit.",
        verify: "committed",
      },
      {
        kind: "gate",
        id: "gate-push",
        title: "Approve push",
        message: "Push to the remote?",
      },
      { kind: "action", id: "push", title: "Push", op: "push" },
    ],
  },
  {
    id: "ship-it",
    name: "Ship it",
    description: "Commit, push, open a pull request, then squash-merge after approval.",
    builtin: true,
    steps: [
      {
        kind: "gate",
        id: "gate-commit",
        title: "Approve commit",
        message: "Commit and open a PR?",
      },
      {
        kind: "agent",
        id: "commit",
        title: "Commit all changes",
        prompt: "Make one AI-written commit from the current diff.",
        verify: "committed",
      },
      { kind: "action", id: "push", title: "Push", op: "push" },
      {
        kind: "agent",
        id: "open-pr",
        title: "Open a PR",
        prompt: "Open a GitHub PR for the current branch using the NoMoreIDE GitHub tools.",
      },
      {
        kind: "gate",
        id: "gate-merge",
        title: "Approve merge",
        message: "Squash-merge the pull request?",
      },
    ],
  },
  {
    id: "demo-sql-review",
    name: "Review SQL change",
    description: "Ask the agent to draft a SQL update, then stage it for the human SQL console.",
    steps: [
      {
        kind: "agent",
        id: "draft-sql",
        title: "Draft SQL",
        prompt: "Draft the SQL update in a sql-write block so the human can preview it before commit.",
      },
    ],
  },
];

const githubPrs: GitHubPR[] = [
  {
    number: 84,
    title: "feat: add workflow authoring demo",
    state: "open",
    body: "Adds workflow composer coverage and a current website mock.",
    html_url: "https://github.com/acme/web/pull/84",
    head: { ref: "feat/website-real-ui-demo", sha: "a1b2c3d" },
    base: { ref: "main" },
    user: { login: "demo-user" },
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 8).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
    merged_at: null,
    draft: false,
    mergeable: true,
  },
  {
    number: 79,
    title: "fix: keep agent workflow runs visible",
    state: "merged",
    body: "Hoists active workflow run state so page changes do not hide progress.",
    html_url: "https://github.com/acme/web/pull/79",
    head: { ref: "fix/workflow-run-state", sha: "1122334" },
    base: { ref: "main" },
    user: { login: "demo-user" },
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 30).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    merged_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    draft: false,
    mergeable: true,
  },
];

const githubIssues: GitHubIssue[] = [
  {
    number: 32,
    title: "Document SQL write preview safety",
    state: "open",
    body: "Explain unlock, preview, and commit flow for the database SQL console.",
    html_url: "https://github.com/acme/web/issues/32",
    user: { login: "demo-user" },
    labels: [{ name: "docs", color: "2563eb" }],
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 20).toISOString(),
    comments: 2,
  },
  {
    number: 29,
    title: "Show failed workflow result in Git banner",
    state: "open",
    body: "When a workflow blocks, keep the reason visible in the Git review surface.",
    html_url: "https://github.com/acme/web/issues/29",
    user: { login: "qa-demo" },
    labels: [{ name: "workflow", color: "16a34a" }],
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 18).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    comments: 1,
  },
];

const githubComments: GitHubComment[] = [
  {
    id: 4101,
    body: "Mock comment: the SQL write docs should mention that MCP database tools remain read-only.",
    user: { login: "docs-reviewer" },
    created_at: new Date(Date.now() - 1000 * 60 * 18).toISOString(),
    html_url: "https://github.com/acme/web/issues/32#issuecomment-4101",
  },
];

const githubChecks: GitHubCheckRun[] = [
  {
    id: 9001,
    name: "website build",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/acme/web/actions/runs/9001",
    started_at: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
    completed_at: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
  },
  {
    id: 9002,
    name: "typecheck",
    status: "completed",
    conclusion: "failure",
    html_url: "https://github.com/acme/web/actions/runs/9002",
    started_at: new Date(Date.now() - 1000 * 60 * 13).toISOString(),
    completed_at: new Date(Date.now() - 1000 * 60 * 11).toISOString(),
  },
];

const githubRuns: GitHubWorkflowRun[] = [
  {
    id: 9001,
    name: "CI",
    status: "completed",
    conclusion: "failure",
    html_url: "https://github.com/acme/web/actions/runs/9001",
    head_sha: "a1b2c3d",
    head_branch: "feat/website-real-ui-demo",
    created_at: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 11).toISOString(),
    run_number: 184,
    event: "pull_request",
  },
  {
    id: 8996,
    name: "CI",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/acme/web/actions/runs/8996",
    head_sha: "1122334",
    head_branch: "main",
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    updated_at: new Date(Date.now() - 1000 * 60 * 60 * 23).toISOString(),
    run_number: 183,
    event: "push",
  },
];

const githubJobs: GitHubWorkflowJob[] = [
  {
    id: 9010,
    run_id: 9001,
    html_url: "https://github.com/acme/web/actions/runs/9001/job/9010",
    status: "completed",
    conclusion: "failure",
    started_at: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
    completed_at: new Date(Date.now() - 1000 * 60 * 11).toISOString(),
    name: "build-and-test",
    steps: [
      { name: "Checkout", status: "completed", conclusion: "success", number: 1, started_at: null, completed_at: null },
      { name: "Install", status: "completed", conclusion: "success", number: 2, started_at: null, completed_at: null },
      { name: "Typecheck", status: "completed", conclusion: "failure", number: 3, started_at: null, completed_at: null },
    ],
  },
];

export function installWebsiteMockApi() {
  if (typeof window === "undefined") return;
  const currentWindow = window as Window & { __nomoreideWebsiteMockApi?: boolean };
  if (currentWindow.__nomoreideWebsiteMockApi) return;
  currentWindow.__nomoreideWebsiteMockApi = true;

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl, window.location.origin);
    if (!url.pathname.startsWith("/api/")) {
      return realFetch(input, init);
    }

    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    return handleApi(url, method, init);
  };
}

function handleApi(url: URL, method: string, init?: RequestInit): Response {
  const path = url.pathname;

  if (path === "/api/dashboard") return json(dashboard());
  if (path === "/api/log-sources") return json({ ok: true, sources: [] });
  if (path === "/api/errors") return json({ ok: true, incidents });
  if (path.match(/^\/api\/errors\/\d+\/prompt$/)) {
    return json({
      ok: true,
      incident: incidents[0],
      file: files[incidents[0].file ?? ""] ?? "",
      prompt: "Explain this warning and suggest how to replace placeholder credentials safely.",
    });
  }
  if (path.match(/^\/api\/errors\/\d+\/bundle$/)) {
    return json({
      ok: true,
      incidentId: 1,
      markdown: "# Demo repro bundle\n\nPlaceholder credentials are visible only in the website mock.",
    });
  }

  if (path === "/api/git/diff") return text(diffs[url.searchParams.get("file") ?? ""] ?? "");
  if (path === "/api/git/files") return json({ ok: true, files: Object.keys(files) });
  if (path === "/api/git/file-sizes") {
    return json({
      ok: true,
      files: Object.entries(files).map(([filePath, content]) => ({
        path: filePath,
        lines: content.split("\n").length,
        bytes: content.length,
        truncated: false,
      })),
    });
  }
  if (path === "/api/git/file") {
    const filePath = url.searchParams.get("path") ?? "README.md";
    if (method === "PUT") return json({ ok: true });
    return json({
      ok: true,
      content: files[filePath] ?? "",
      truncated: false,
      binary: false,
      size: files[filePath]?.length ?? 0,
    });
  }
  if (path === "/api/git/graph") return json({ ok: true, commits: gitGraph() });
  if (path === "/api/git/status") return json({ ok: true, status: gitStatus });
  if (path === "/api/git/commit/files") return json({ ok: true, files: gitFiles });
  if (path === "/api/git/commit") return text(Object.values(diffs).join("\n\n"));
  if (path === "/api/git/push") {
    return json({
      ok: true,
      output: "Pushed feat/website-real-ui-demo to origin.",
      branch: gitStatus.branch,
      setUpstream: false,
    });
  }

  if (path === "/api/workflows") {
    if (method === "POST") return json({ ok: true, workflows });
    return json({ ok: true, workflows });
  }
  if (path.match(/^\/api\/workflows\/[^/]+$/)) {
    return json({ ok: true, workflows });
  }

  if (path === "/api/github/token") {
    return json({ ok: true, configured: true, deviceFlowAvailable: true });
  }
  if (path.startsWith("/api/github/oauth/")) {
    return json({ ok: true, done: path.endsWith("/poll") });
  }
  if (path === "/api/github/prs") {
    if (method === "POST") return json({ ok: true, pr: githubPrs[0] });
    return json({ ok: true, prs: githubPrs });
  }
  if (path === "/api/github/issues") {
    if (method === "POST") return json({ ok: true, issue: githubIssues[0] });
    return json({ ok: true, issues: githubIssues });
  }
  const githubPrDiff = path.match(/^\/api\/github\/prs\/(\d+)\/diff$/);
  if (githubPrDiff) return text(diffs["src/config/services.json"]);
  const githubPrMerge = path.match(/^\/api\/github\/prs\/(\d+)\/merge$/);
  if (githubPrMerge) {
    return json({
      ok: true,
      merged: true,
      sha: "feed123",
      message: `Mock merged PR #${githubPrMerge[1]}.`,
    });
  }
  const githubPr = path.match(/^\/api\/github\/prs\/(\d+)$/);
  if (githubPr) {
    const number = Number(githubPr[1]);
    return json({ ok: true, pr: githubPrs.find((pr) => pr.number === number) ?? githubPrs[0] });
  }
  const githubIssueComments = path.match(/^\/api\/github\/issues\/(\d+)\/comments$/);
  if (githubIssueComments) {
    return json({
      ok: true,
      comments: githubComments,
      comment: githubComments[0],
    });
  }
  const githubIssue = path.match(/^\/api\/github\/issues\/(\d+)$/);
  if (githubIssue) {
    const number = Number(githubIssue[1]);
    return json({
      ok: true,
      issue: githubIssues.find((issue) => issue.number === number) ?? githubIssues[0],
    });
  }
  const githubCi = path.match(/^\/api\/github\/ci\/([^/]+)$/);
  if (githubCi) {
    return json({
      ok: true,
      status: {
        sha: githubCi[1],
        state: "failure",
        totalCount: githubChecks.length,
        runs: githubChecks,
      },
    });
  }
  if (path === "/api/github/runs") return json({ ok: true, runs: githubRuns });
  if (path.match(/^\/api\/github\/runs\/\d+\/jobs$/)) {
    return json({ ok: true, jobs: githubJobs });
  }

  if (path === "/api/agent") return json({ ok: true, agent: agentInfo() });
  if (path === "/api/agent/chat/status") {
    return json({
      ok: true,
      configured: true,
      approvals: false,
      provider: {
        id: "codex",
        label: "Codex CLI",
        commandName: "codex",
        installHint: "This website uses a mocked provider.",
        intro: "Ask about services, diffs, logs, or placeholder configuration.",
      },
    });
  }
  if (path === "/api/agent/chat") return agentStream();
  if (path === "/api/agent/mcp-status") {
    return json({
      ok: true,
      statuses: [
        { name: "nomoreide", state: "connected" },
        { name: "github", state: "no-auth" },
      ],
    });
  }
  if (path === "/api/agent/tool-calls") {
    return json({
      ok: true,
      records: [
        {
          id: 1,
          tool: "nomoreide.get_dashboard",
          startedAt,
          durationMs: 42,
          status: "ok",
          args: "{}",
        },
      ],
    });
  }
  if (path === "/api/agent/usage") {
    return json({
      ok: true,
      usage: {
        codex: {
          timestamp: new Date().toISOString(),
          inputTokens: 12400,
          cachedInputTokens: 8200,
          outputTokens: 1900,
          reasoningOutputTokens: 640,
          totalTokens: 14940,
          lastInputTokens: 1800,
          lastCachedInputTokens: 1200,
          lastOutputTokens: 340,
          lastReasoningOutputTokens: 90,
          lastTotalTokens: 2230,
          contextWindow: 200000,
          primary: { usedPercent: 18, resetsAtUnix: Math.floor(Date.now() / 1000) + 3600 },
        },
      },
    });
  }
  if (path === "/api/agent/claude-settings") {
    return json({ ok: true, settings: { coAuthorWithClaude: false } });
  }

  if (path === "/api/databases") return json({ ok: true, connections: databases() });
  if (path === "/api/databases/detect") {
    return json({
      ok: true,
      detected: [
        {
          service: "api",
          key: "DATABASE_URL",
          engine: "postgres",
          url: "postgres://demo_user:demo_password@localhost:5432/app",
          maskedUrl: "postgres://demo_user:****@localhost:5432/app",
        },
      ],
    });
  }
  if (path.match(/^\/api\/databases\/[^/]+\/tables$/)) {
    return json({
      ok: true,
      tables: getWebsiteMockDatabaseTables(),
    });
  }
  if (path.match(/^\/api\/databases\/[^/]+\/rows$/)) {
    return json(
      getWebsiteMockDatabaseRows(
        url.searchParams.get("table") ?? "public.users",
        Number(url.searchParams.get("limit") ?? 100),
        Number(url.searchParams.get("offset") ?? 0),
      ),
    );
  }
  if (path.match(/^\/api\/databases\/[^/]+\/query$/)) {
    return json({
      ok: true,
      engine: "postgres",
      columns: mockDatabaseTables[0].columns,
      rows: mockDatabaseTables[0].rows,
      rowCount: mockDatabaseTables[0].rows.length,
      truncated: false,
    });
  }
  if (path.match(/^\/api\/databases\/[^/]+\/write-access$/)) {
    databaseWriteUnlocked = !databaseWriteUnlocked;
    return json({ ok: true, writeUnlocked: databaseWriteUnlocked });
  }
  if (path.match(/^\/api\/databases\/[^/]+\/execute$/)) {
    const committed = init?.body instanceof URLSearchParams
      ? init.body.get("mode") === "commit"
      : false;
    return json({
      ok: true,
      engine: "postgres",
      previewUnavailable: false,
      affectedRows: 1,
      rows: [{ id: "usr_01hx8q9n", role: "developer" }],
      columns: [
        { name: "id", dataType: "uuid", nullable: false, primaryKey: true },
        { name: "role", dataType: "text", nullable: false, primaryKey: false },
      ],
      committed,
    });
  }
  if (path === "/api/databases/test") return json({ ok: true });

  if (path === "/api/terminal/sessions") {
    if (method === "POST") {
      terminalSessions = [...terminalSessions];
    }
    return json({ ok: true, sessions: terminalSessions, session: terminalSessions[0] });
  }

  const serviceAction = path.match(/^\/api\/services\/([^/]+)\/(start|stop|restart)$/);
  if (serviceAction) {
    const name = decodeURIComponent(serviceAction[1]);
    const action = serviceAction[2];
    serviceStates = {
      ...serviceStates,
      [name]: action === "stop" ? "stopped" : "running",
    };
    return json({ ok: true });
  }

  const bundleAction = path.match(/^\/api\/bundles\/([^/]+)\/(start|stop|restart)$/);
  if (bundleAction) {
    const action = bundleAction[2];
    serviceStates = Object.fromEntries(
      Object.keys(serviceStates).map((name) => [name, action === "stop" ? "stopped" : "running"]),
    );
    return json({ ok: true });
  }

  const serviceName = path.match(/^\/api\/services\/([^/]+)/)?.[1];
  if (serviceName) {
    const name = decodeURIComponent(serviceName);
    if (path.endsWith("/logs")) return json({ ok: true, logs: logs(name), queryable: false });
    if (path.endsWith("/metrics")) return json({ ok: true, metrics: metrics(name) });
    if (path.endsWith("/config-files")) {
      return json({
        ok: true,
        cwd: serviceDefinitions.find((service) => service.name === name)?.cwd ?? "/Users/demo",
        files: [{ path: ".env.local", relativePath: ".env.local", format: "env" }],
      });
    }
    if (path.includes("/config-file")) {
      return json({
        ok: true,
        exists: true,
        format: "env",
        path: ".env.local",
        relativePath: ".env.local",
        entries: [
          { key: "DATABASE_URL", value: "postgres://demo_user:demo_password@localhost:5432/app", secret: true },
          { key: "GITHUB_TOKEN", value: "ghp_demo_placeholder", secret: true },
          { key: "PUBLIC_APP_URL", value: "http://127.0.0.1:5173", secret: false },
        ],
      });
    }
    if (path.endsWith("/config-browse")) {
      return json({
        ok: true,
        cwd: "/Users/demo/projects/acme",
        currentPath: "/Users/demo/projects/acme",
        relativePath: "",
        isRoot: true,
        entries: [{ name: ".env.local", relativePath: ".env.local", kind: "file", format: "env", supported: true }],
      });
    }
    if (path.endsWith("/test")) {
      return json({
        ok: true,
        run: {
          id: 1,
          service: name,
          command: "npm test",
          status: "passed",
          startedAt,
          endedAt: new Date().toISOString(),
          exitCode: 0,
          failingCount: 0,
        },
      });
    }
  }

  if (path === "/api/services" || path === "/api/bundles" || path === "/api/fs/directories") {
    return json({ ok: true, path: "/Users/demo/projects", parent: "/Users/demo", entries: [] });
  }

  return json({ ok: true });
}

function dashboard(): DashboardData {
  return {
    ok: true,
    cwd: "/Users/demo/projects/acme",
    config: {
      services: serviceDefinitions,
      bundles: [{ name: "Demo stack", services: ["web-client", "api", "worker"] }],
      gitRepositories: [{ name: "acme", path: "/Users/demo/projects/acme" }],
      selectedGitRepository: "acme",
    },
    runtime: {
      services: Object.fromEntries(
        serviceDefinitions.map((service) => [
          service.name,
          {
            name: service.name,
            state: serviceStates[service.name] ?? "stopped",
            pid: serviceStates[service.name] === "running" ? 7300 + service.port : undefined,
            url: `http://127.0.0.1:${service.port}`,
            startedAt,
            kind: "local",
            processTree:
              serviceStates[service.name] === "running"
                ? {
                    rootPid: 7300 + service.port,
                    processCount: 3,
                    cpuPercent: service.name === "api" ? 6.2 : 2.1,
                    rssMb: service.name === "api" ? 184 : 96,
                    processes: [
                      {
                        pid: 7300 + service.port,
                        ppid: 1,
                        cpuPercent: 2.1,
                        rssMb: 96,
                        command: service.command ?? service.name,
                      },
                    ],
                  }
                : undefined,
          },
        ]),
      ),
    },
    ports: serviceDefinitions.map((service) => ({
      port: service.port ?? 0,
      available: serviceStates[service.name] !== "running",
      hosts: [{ host: "127.0.0.1", available: serviceStates[service.name] !== "running" }],
      state: serviceStates[service.name] === "running" ? "managed" : "available",
      services: [service.name],
      urls: [`http://127.0.0.1:${service.port}`],
    })),
    health: Object.fromEntries(
      serviceDefinitions.map((service) => [
        service.name,
        {
          service: service.name,
          status: serviceStates[service.name] === "running" ? "healthy" : "unknown",
          summary:
            serviceStates[service.name] === "running"
              ? `Healthy on port ${service.port}`
              : "Stopped in mock data",
          checkedAt: new Date().toISOString(),
          checks: [{ name: "HTTP", ok: serviceStates[service.name] === "running", summary: "Mock probe", latencyMs: 24 }],
          ports: [],
          agentContext: `${service.name} is using website mock data with placeholder credentials only.`,
        },
      ]),
    ),
    timeline: [
      {
        id: "1",
        timestamp: new Date().toISOString(),
        kind: "git.change",
        severity: "info",
        title: "3 files changed",
        detail: "Mock git status loaded from website data.",
      },
    ],
    logs: logs("api"),
    git: {
      cwd: "/Users/demo/projects/acme",
      selectedRepository: { name: "acme", path: "/Users/demo/projects/acme" },
      status: gitStatus,
      branches: [
        { name: "feat/website-real-ui-demo", current: true, remote: false },
        { name: "main", current: false, remote: false, upstream: "origin/main" },
      ],
    },
  };
}

function logs(service: string): LogEntry[] {
  return [
    "ready on http://127.0.0.1",
    "GET /api/dashboard 200 22ms",
    "using placeholder DATABASE_URL for website mock",
    "git diff loaded from static mock",
  ].map((textValue, index) => ({
    service,
    stream: index === 2 ? "stderr" : "stdout",
    text: `[${service}] ${textValue}`,
    timestamp: new Date(Date.now() - index * 9000).toISOString(),
  }));
}

function metrics(service: string) {
  const sampleIntervalMs = 5000;
  const count = 48;
  // Per-service profile so each chart looks distinct and realistic.
  const profile =
    service === "api"
      ? { cpuBase: 6, cpuAmp: 5, rssBase: 190, rssGrowth: 60 }
      : service === "worker"
        ? { cpuBase: 3, cpuAmp: 8, rssBase: 96, rssGrowth: 24 }
        : { cpuBase: 2, cpuAmp: 3, rssBase: 384, rssGrowth: 40 };
  const seed = service.length * 3 + 1;
  return {
    service,
    startedAt,
    sampleIntervalMs,
    samples: Array.from({ length: count }, (_, index) => {
      const phase = index / count;
      // Smooth multi-frequency wave + gentle deterministic jitter (no Math.random
      // so the demo render is stable across reloads).
      const wave =
        Math.sin(phase * Math.PI * 4 + seed) * 0.6 +
        Math.sin(phase * Math.PI * 9 + seed * 2) * 0.4;
      const jitter = ((index * 7 + seed) % 5) / 5 - 0.5;
      return {
        t: Date.now() - (count - 1 - index) * sampleIntervalMs,
        cpu: Math.max(0.3, profile.cpuBase + profile.cpuAmp * (wave + jitter * 0.4)),
        rss: profile.rssBase + profile.rssGrowth * phase + profile.rssGrowth * 0.15 * wave,
      };
    }),
  };
}

function gitGraph(): GitGraphCommit[] {
  return [
    {
      hash: "a1b2c3d",
      parents: ["1122334"],
      author: "Demo User",
      email: "demo@example.com",
      timestamp: Math.floor(Date.now() / 1000) - 120,
      subject: "feat: mock real dashboard in website",
      refs: [{ name: "HEAD", kind: "head" }, { name: "feat/website-real-ui-demo", kind: "branch" }],
      lane: 0,
      laneCount: 1,
      edges: [],
      throughLanes: [],
    },
    {
      hash: "1122334",
      parents: [],
      author: "Demo User",
      email: "demo@example.com",
      timestamp: Math.floor(Date.now() / 1000) - 3600,
      subject: "chore: prepare placeholder config",
      refs: [{ name: "main", kind: "branch" }],
      lane: 0,
      laneCount: 1,
      edges: [],
      throughLanes: [],
    },
  ];
}

function agentInfo(): AgentInfo {
  const profile = {
    project: {
      cwd: "/Users/demo/projects/acme",
      instructionFilePath: "/Users/demo/projects/acme/CLAUDE.md",
      instructionFileName: "CLAUDE.md",
      instructionFilePreview: "Use placeholder credentials in public examples.",
      memoryFiles: [
        {
          path: "/Users/demo/.codex/memories/demo.md",
          name: "demo.md",
          size: 128,
          preview: "Website mock data only.",
        },
      ],
    },
    skills: [
      {
        name: "frontend-design",
        scope: "plugin" as const,
        path: "/Users/demo/.codex/skills/frontend-design",
        description: "Build polished frontend UI.",
      },
    ],
    mcpServers: [{ name: "nomoreide", scope: "project" as const, command: "npx", args: ["-y", "nomoreide"] }],
    plugins: [
      {
        name: "workflow-pack",
        marketplace: "demo",
        scope: "user" as const,
        version: "1.0.0",
        description: "Mock plugin contributions for the public demo.",
        skills: ["frontend-design"],
        commands: ["review"],
        agents: [],
        mcpServers: ["nomoreide"],
      },
    ],
    hooks: [
      {
        id: "/Users/demo/projects/acme/.claude/settings.json:PreToolUse:0:0",
        event: "PreToolUse",
        scope: "project" as const,
        settingsPath: "/Users/demo/projects/acme/.claude/settings.json",
        matcher: "Bash|Write",
        type: "command",
        command: "node .claude/hooks/guard.js",
        status: "enabled" as const,
        trusted: true,
      },
    ],
    projects: [
      {
        path: "/Users/demo/projects/acme",
        current: true,
        lastSessionFirstPrompt: "Review this mock diff",
        lastSessionModified: new Date().toISOString(),
        mcpServerCount: 1,
      },
    ],
  };
  return {
    ...profile,
    detected: {
      name: "codex",
      label: "Codex CLI",
      signals: ["website mock"],
      parentProcess: "vite",
    },
    agents: {
      "claude-code": profile,
      codex: profile,
    },
  };
}

function databases(): DatabaseConnection[] {
  return [
    {
      name: "acme-local",
      engine: "postgres",
      url: "postgres://demo_user:****@localhost:5432/acme",
      writeUnlocked: databaseWriteUnlocked,
    },
  ];
}

type MockTable = {
  table: TableRef;
  columns: ColumnInfo[];
  rows: Array<Record<string, unknown>>;
};

const mockDatabaseTables: MockTable[] = [
  {
    table: { schema: "public", name: "users", qualifiedName: "public.users" },
    columns: [
      { name: "id", dataType: "uuid", nullable: false, primaryKey: true },
      { name: "email", dataType: "text", nullable: false, primaryKey: false },
      { name: "name", dataType: "text", nullable: false, primaryKey: false },
      { name: "role", dataType: "text", nullable: false, primaryKey: false },
      { name: "created_at", dataType: "timestamptz", nullable: false, primaryKey: false },
      { name: "last_seen_at", dataType: "timestamptz", nullable: true, primaryKey: false },
    ],
    rows: [
      { id: "usr_01hx8q9m", email: "alex@example.test", name: "Alex Chen", role: "owner", created_at: "2026-05-01T09:15:00Z", last_seen_at: "2026-05-30T03:58:12Z" },
      { id: "usr_01hx8q9n", email: "sam@example.test", name: "Sam Rivera", role: "developer", created_at: "2026-05-03T14:20:00Z", last_seen_at: "2026-05-30T02:44:19Z" },
      { id: "usr_01hx8q9p", email: "mika@example.test", name: "Mika Tan", role: "developer", created_at: "2026-05-08T11:05:00Z", last_seen_at: null },
    ],
  },
  {
    table: { schema: "public", name: "projects", qualifiedName: "public.projects" },
    columns: [
      { name: "id", dataType: "uuid", nullable: false, primaryKey: true },
      { name: "name", dataType: "text", nullable: false, primaryKey: false },
      { name: "repository", dataType: "text", nullable: false, primaryKey: false },
      { name: "default_branch", dataType: "text", nullable: false, primaryKey: false },
      { name: "service_count", dataType: "integer", nullable: false, primaryKey: false },
      { name: "updated_at", dataType: "timestamptz", nullable: false, primaryKey: false },
    ],
    rows: [
      { id: "prj_001", name: "Acme web", repository: "github.com/acme/web", default_branch: "main", service_count: 3, updated_at: "2026-05-30T04:07:11Z" },
      { id: "prj_002", name: "Billing API", repository: "github.com/acme/billing-api", default_branch: "main", service_count: 2, updated_at: "2026-05-29T22:31:08Z" },
      { id: "prj_003", name: "Worker fleet", repository: "github.com/acme/workers", default_branch: "develop", service_count: 4, updated_at: "2026-05-29T18:14:42Z" },
      { id: "prj_004", name: "Mobile gateway", repository: "github.com/acme/mobile-gateway", default_branch: "main", service_count: 1, updated_at: "2026-05-28T13:02:33Z" },
    ],
  },
  {
    table: { schema: "public", name: "subscriptions", qualifiedName: "public.subscriptions" },
    columns: [
      { name: "id", dataType: "uuid", nullable: false, primaryKey: true },
      { name: "user_id", dataType: "uuid", nullable: false, primaryKey: false },
      { name: "plan", dataType: "text", nullable: false, primaryKey: false },
      { name: "status", dataType: "text", nullable: false, primaryKey: false },
      { name: "seats", dataType: "integer", nullable: false, primaryKey: false },
      { name: "renews_at", dataType: "date", nullable: true, primaryKey: false },
    ],
    rows: [
      { id: "sub_001", user_id: "usr_01hx8q9m", plan: "team", status: "active", seats: 8, renews_at: "2026-06-18" },
      { id: "sub_002", user_id: "usr_01hx8q9n", plan: "pro", status: "trialing", seats: 1, renews_at: "2026-06-05" },
      { id: "sub_003", user_id: "usr_01hx8q9p", plan: "free", status: "active", seats: 1, renews_at: null },
    ],
  },
  {
    table: { schema: "public", name: "usage_events", qualifiedName: "public.usage_events" },
    columns: [
      { name: "id", dataType: "bigint", nullable: false, primaryKey: true },
      { name: "project_id", dataType: "uuid", nullable: false, primaryKey: false },
      { name: "event_type", dataType: "text", nullable: false, primaryKey: false },
      { name: "metadata", dataType: "jsonb", nullable: false, primaryKey: false },
      { name: "created_at", dataType: "timestamptz", nullable: false, primaryKey: false },
    ],
    rows: [
      { id: 10842, project_id: "prj_001", event_type: "service.started", metadata: { service: "web-client", port: 5174 }, created_at: "2026-05-30T04:11:52Z" },
      { id: 10843, project_id: "prj_001", event_type: "git.diff.viewed", metadata: { files: 9, branch: "feat/hero" }, created_at: "2026-05-30T04:12:10Z" },
      { id: 10844, project_id: "prj_002", event_type: "database.sampled", metadata: { table: "billing.invoices", rows: 25 }, created_at: "2026-05-30T04:13:02Z" },
      { id: 10845, project_id: "prj_003", event_type: "agent.prompt.sent", metadata: { agent: "codex", attachments: 2 }, created_at: "2026-05-30T04:14:18Z" },
    ],
  },
  {
    table: { schema: "public", name: "agent_runs", qualifiedName: "public.agent_runs" },
    columns: [
      { name: "id", dataType: "uuid", nullable: false, primaryKey: true },
      { name: "agent", dataType: "text", nullable: false, primaryKey: false },
      { name: "status", dataType: "text", nullable: false, primaryKey: false },
      { name: "prompt", dataType: "text", nullable: false, primaryKey: false },
      { name: "tokens", dataType: "integer", nullable: false, primaryKey: false },
      { name: "completed_at", dataType: "timestamptz", nullable: true, primaryKey: false },
    ],
    rows: [
      { id: "run_001", agent: "codex", status: "completed", prompt: "Review this mock diff", tokens: 3920, completed_at: "2026-05-30T03:55:41Z" },
      { id: "run_002", agent: "claude-code", status: "completed", prompt: "Explain failing service health", tokens: 2814, completed_at: "2026-05-30T03:12:09Z" },
      { id: "run_003", agent: "gemini", status: "queued", prompt: "Summarize database row risk", tokens: 0, completed_at: null },
    ],
  },
  {
    table: { schema: "public", name: "service_health", qualifiedName: "public.service_health" },
    columns: [
      { name: "service", dataType: "text", nullable: false, primaryKey: true },
      { name: "state", dataType: "text", nullable: false, primaryKey: false },
      { name: "cpu_percent", dataType: "numeric", nullable: false, primaryKey: false },
      { name: "rss_mb", dataType: "numeric", nullable: false, primaryKey: false },
      { name: "checks", dataType: "jsonb", nullable: false, primaryKey: false },
    ],
    rows: [
      { service: "web-client", state: "running", cpu_percent: 1.8, rss_mb: 386.4, checks: [{ name: "HTTP", ok: true, latencyMs: 24 }] },
      { service: "api", state: "running", cpu_percent: 4.2, rss_mb: 512.9, checks: [{ name: "HTTP", ok: true, latencyMs: 39 }] },
      { service: "worker", state: "stopped", cpu_percent: 0, rss_mb: 0, checks: [{ name: "queue", ok: false, summary: "Stopped in mock data" }] },
    ],
  },
  {
    table: { schema: "billing", name: "invoices", qualifiedName: "billing.invoices" },
    columns: [
      { name: "id", dataType: "text", nullable: false, primaryKey: true },
      { name: "subscription_id", dataType: "uuid", nullable: false, primaryKey: false },
      { name: "amount_cents", dataType: "integer", nullable: false, primaryKey: false },
      { name: "currency", dataType: "text", nullable: false, primaryKey: false },
      { name: "status", dataType: "text", nullable: false, primaryKey: false },
      { name: "issued_at", dataType: "date", nullable: false, primaryKey: false },
    ],
    rows: [
      { id: "inv_2026_001", subscription_id: "sub_001", amount_cents: 4900, currency: "USD", status: "paid", issued_at: "2026-05-18" },
      { id: "inv_2026_002", subscription_id: "sub_002", amount_cents: 1900, currency: "USD", status: "open", issued_at: "2026-05-26" },
      { id: "inv_2026_003", subscription_id: "sub_001", amount_cents: 4900, currency: "USD", status: "draft", issued_at: "2026-06-18" },
    ],
  },
];

export function getWebsiteMockDatabaseTables(): TableRef[] {
  return mockDatabaseTables.map(({ table }) => table);
}

export function getWebsiteMockDatabaseRows(
  qualifiedName: string,
  limit = 100,
  offset = 0,
): { ok: true } & RowSample {
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
  const normalizedOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const sample = mockDatabaseTables.find(({ table }) => table.qualifiedName === qualifiedName) ?? mockDatabaseTables[0];

  return {
    ok: true,
    engine: "postgres",
    table: sample.table,
    columns: sample.columns,
    rows: sample.rows.slice(normalizedOffset, normalizedOffset + normalizedLimit),
    rowCount: sample.rows.length,
    limit: normalizedLimit,
    offset: normalizedOffset,
  };
}

function agentStream(): Response {
  const encoder = new TextEncoder();
  const events = [
    { type: "session", sessionId: "website-demo-session" },
    { type: "text", text: "I checked the mocked services, placeholder env, and git diff. " },
    { type: "text", text: "No real credentials are exposed; all sensitive values are demo placeholders." },
    { type: "done", stopReason: "end_turn" },
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function text(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain" },
  });
}
