import type {
  AgentInfo,
  AppSettings,
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
  ProjectPreferences,
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

const createMockGlobalSettings = (): AppSettings => ({
  version: 1 as const,
  terminal: {
    fontSize: 13,
    cursorStyle: "block" as const,
    scrollback: 5_000,
    copyOnSelect: false,
    confirmTerminate: true,
  },
});

const createMockProjectSettings = (): ProjectPreferences => ({
  logs: { showTimestamps: true, wrapLines: true },
  database: { confirmWrites: true, resultLimit: 100 },
});

let mockGlobalSettings = createMockGlobalSettings();
const mockProjectSettingsByPath = new Map<string, ProjectPreferences>();

function projectSettings(url: URL): ProjectPreferences {
  const path = url.searchParams.get("projectPath") ?? "";
  const existing = mockProjectSettingsByPath.get(path);
  if (existing) return existing;
  const created = createMockProjectSettings();
  mockProjectSettingsByPath.set(path, created);
  return created;
}

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

// Shell and agent tabs share these fields; `provider` is agent-only. Typed as a
// union so pushing an agent session into the array typechecks (it seeds with a
// single shell session, which would otherwise pin the element type to shell).
type DemoTerminalSession = {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  shell: string;
  state: "running";
  kind: "shell" | "agent";
  label: string;
  provider?: "claude" | "codex";
  prompt?: string;
};

let terminalSessions: DemoTerminalSession[] = [
  {
    id: "demo-claude-agent",
    cwd: "/Users/demo/projects/acme",
    cols: 100,
    rows: 28,
    shell: "claude",
    state: "running" as const,
    kind: "agent" as const,
    provider: "claude",
    label: "Investigate service health",
    prompt: "Check the unhealthy worker and explain the safest next step.",
  },
  {
    id: "demo-codex-agent",
    cwd: "/Users/demo/projects/acme",
    cols: 100,
    rows: 28,
    shell: "codex",
    state: "running" as const,
    kind: "agent" as const,
    provider: "codex",
    label: "Review current diff",
    prompt: "Review the current diff for correctness and credential safety.",
  },
];

const mockAgentProviders = [
  {
    id: "claude" as const,
    label: "Claude Code",
    commandName: "claude",
    configured: true,
    installHint: "Mocked in this website demo.",
    intro: "Ask Claude Code to investigate services, logs, and project context.",
  },
  {
    id: "codex" as const,
    label: "Codex",
    commandName: "codex",
    configured: true,
    installHint: "Mocked in this website demo.",
    intro: "Ask Codex to review diffs, run checks, and prepare focused changes.",
  },
];

let mockAgentProviderId: "claude" | "codex" = "claude";

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

// No live event bus in the website demo, so there are no configured triggers.
const workflowTriggers: never[] = [];

// Working-tree checkpoints (IDEAS #6). Demo data so the Snapshots tab renders
// with content; the diffs reuse the same mock git diffs as the Git view.
const snapshots = [
  {
    sha: "9f3c1a2b7d4e5a6c8b0d1e2f3a4b5c6d7e8f9a0b",
    ref: "refs/nomoreide/snapshots/1717000000-before-billing-refactor",
    label: "Before billing refactor",
    createdAt: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
  },
  {
    sha: "4d7e88aa11223344556677889900aabbccddeeff",
    ref: "refs/nomoreide/snapshots/1716990000-agent-session",
    label: "Auto: agent session start",
    createdAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
  },
];

const snapshotFiles = gitFiles.map((file) => ({
  status: file.index !== " " ? file.index : file.workingTree,
  path: file.path,
}));

// Agent change-sets (IDEAS #11) — files an agent session touched.
const changeSessions = [
  {
    id: "session-2026-demo",
    repoPath: "/Users/demo/projects/acme",
    snapshotSha: snapshots[1].sha,
    snapshotRef: snapshots[1].ref,
    startedAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
    lastToolAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
    toolCount: 7,
  },
];

// Agent cost / run history (IDEAS #12).
const usageHistory = (() => {
  const day = (offset: number) =>
    new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  const byDay = [
    { date: day(2), costUSD: 0.42, runs: 3, totalTokens: 48200 },
    { date: day(1), costUSD: 0.91, runs: 5, totalTokens: 96400 },
    { date: day(0), costUSD: 0.37, runs: 2, totalTokens: 41100 },
  ];
  return {
    entries: [
      {
        at: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
        source: "claude" as const,
        sessionId: "session-2026-demo",
        inputTokens: 28400,
        outputTokens: 3200,
        totalTokens: 31600,
        costUSD: 0.37,
        models: ["claude-opus-4"],
      },
    ],
    summary: {
      runs: 10,
      totalCostUSD: 1.7,
      totalInputTokens: 158000,
      totalOutputTokens: 27700,
      totalTokens: 185700,
      firstAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      lastAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
      byDay,
      codexTotalTokens: 14940,
    },
  };
})();

const githubRepo = {
  full_name: "acme/web",
  html_url: "https://github.com/acme/web",
  default_branch: "main",
};

const githubBranchesPayload = {
  repository: githubRepo,
  defaultBranch: "main",
  currentBranch: "feat/website-real-ui-demo",
  branches: [
    { name: "feat/website-real-ui-demo", protected: false, commit: { sha: "a1b2c3d" } },
    { name: "main", protected: true, commit: { sha: "1122334" } },
    { name: "fix/workflow-run-state", protected: false, commit: { sha: "1122334" } },
  ],
};

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

// Agent Environments demo data: three agents with plausible MCPs and skills.
const agentEnvAgents = [
  { agent: "claude", available: true, command: "claude", resolvedPath: "/usr/local/bin/claude" },
  { agent: "codex", available: true, command: "codex", resolvedPath: "/usr/local/bin/codex" },
  { agent: "antigravity", available: false, command: "antigravity" },
];

const agentEnvConfigs = [
  {
    agent: "claude",
    configPath: "/Users/demo/.claude.json",
    exists: true,
    mcpServers: {
      nomoreide: { command: "npx", args: ["-y", "nomoreide", "mcp"] },
      postgres: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres"] },
    },
    remoteMcpServers: {
      linear: { transport: "http", url: "https://mcp.linear.app/mcp" },
    },
    projectMcpServers: {
      playwright: { command: "npx", args: ["-y", "@playwright/mcp"] },
    },
    projectRemoteMcpServers: {},
    skills: [
      {
        name: "code-review",
        source: "claude-plugins-official",
        kind: "plugin",
        scope: "user",
        installPath: "/Users/demo/.claude/plugins/cache/claude-plugins-official/code-review/1.0.0",
        pluginSkills: ["review", "security-review"],
        pluginAgents: ["code-reviewer"],
        pluginCommands: ["review"],
      },
      { name: "commit-push", source: "local", kind: "skill", scope: "user" },
      { name: "deploy-checklist", source: "local", kind: "skill", scope: "project" },
    ],
  },
  {
    agent: "codex",
    configPath: "/Users/demo/.codex/config.toml",
    exists: true,
    mcpServers: {
      nomoreide: { command: "npx", args: ["-y", "nomoreide", "mcp"] },
    },
    remoteMcpServers: {
      docs: { transport: "http", url: "https://developers.openai.com/mcp" },
    },
    projectMcpServers: {},
    projectRemoteMcpServers: {},
    skills: [
      { name: "commit-push", source: "local", kind: "skill", scope: "user" },
      {
        name: "code-review",
        source: "claude-plugins-official",
        kind: "plugin",
        scope: "user",
        managed: true,
        pluginSkills: ["review"],
        pluginCommands: ["code-review"],
      },
    ],
  },
  {
    agent: "antigravity",
    configPath: "/Users/demo/.gemini/antigravity-cli/mcp_config.json",
    exists: false,
    mcpServers: {},
    remoteMcpServers: {},
    projectMcpServers: {},
    projectRemoteMcpServers: {},
    skills: [],
  },
];

const agentEnvProfiles = [
  {
    name: "fullstack-dev",
    description: "GitHub + Linear + docs MCPs with the commit-push skill",
    sourceAgent: "codex",
    mcpCount: 3,
    skillCount: 1,
    pluginCount: 1,
    updatedAt: "2026-07-05T09:30:00.000Z",
  },
  {
    name: "backup-claude",
    description: "Snapshot of Claude Code before the last bulk change",
    sourceAgent: "claude",
    mcpCount: 2,
    skillCount: 2,
    pluginCount: 2,
    updatedAt: "2026-07-01T18:12:00.000Z",
  },
  {
    name: "minimal-review",
    mcpCount: 1,
    skillCount: 0,
    pluginCount: 0,
    updatedAt: "2026-06-20T08:00:00.000Z",
  },
];

export function installWebsiteMockApi() {
  if (typeof window === "undefined") return;
  const currentWindow = window as Window & { __nomoreideWebsiteMockApi?: boolean };
  if (currentWindow.__nomoreideWebsiteMockApi) return;
  currentWindow.__nomoreideWebsiteMockApi = true;

  window.WebSocket = WebsiteDemoWebSocket as unknown as typeof WebSocket;

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

  if (path === "/api/settings" && method === "GET") {
    return json({ ok: true, global: mockGlobalSettings, project: projectSettings(url) });
  }
  if (path === "/api/settings/global" && method === "PATCH") {
    const patch = parseJsonBody(init) as { terminal?: Partial<typeof mockGlobalSettings.terminal> };
    mockGlobalSettings = {
      ...mockGlobalSettings,
      terminal: { ...mockGlobalSettings.terminal, ...patch.terminal },
    };
    return json({ ok: true, global: mockGlobalSettings });
  }
  if (path === "/api/settings/project" && method === "PATCH") {
    const current = projectSettings(url);
    const patch = parseJsonBody(init) as {
      logs?: Partial<ProjectPreferences["logs"]>;
      database?: Partial<ProjectPreferences["database"]>;
    };
    const updated = {
      logs: { ...current.logs, ...patch.logs },
      database: { ...current.database, ...patch.database },
    };
    mockProjectSettingsByPath.set(url.searchParams.get("projectPath") ?? "", updated);
    return json({ ok: true, project: updated });
  }
  if (path === "/api/settings/global/reset" && method === "POST") {
    mockGlobalSettings = createMockGlobalSettings();
    return json({ ok: true, global: mockGlobalSettings });
  }
  if (path === "/api/settings/project/reset" && method === "POST") {
    const project = createMockProjectSettings();
    mockProjectSettingsByPath.set(url.searchParams.get("projectPath") ?? "", project);
    return json({ ok: true, project });
  }

  if (path === "/api/dashboard") return json(dashboard());
  if (path === "/api/metrics") return json({ ok: true, metrics: activityMetrics() });
  if (path === "/api/processes/terminate" && method === "POST") {
    return json({ ok: true });
  }

  // Agent Environments (ROR-60). All three endpoints are read-on-mount.
  if (path === "/api/agent-env/agents") {
    return json({ ok: true, agents: agentEnvAgents });
  }
  if (path === "/api/agent-env/live") {
    return json({ ok: true, configs: agentEnvConfigs });
  }
  if (path === "/api/agent-env/doctor") {
    return json({
      ok: true,
      checks: [
        { label: "Agent CLI", status: "ok", message: "claude is available (/usr/local/bin/claude)" },
        { label: "Agent CLI", status: "ok", message: "codex is available (/usr/local/bin/codex)" },
        { label: "Agent CLI", status: "warn", message: "antigravity is not available on PATH" },
        { label: "Config file", status: "ok", message: "claude config found at ~/.claude.json" },
        { label: "Config file", status: "ok", message: "codex config found at ~/.codex/config.toml" },
      ],
      hasIssues: true,
    });
  }
  // Agent Environments staged writes (ROR-61): preview echoes the staged
  // changes so the drawer renders; apply pretends everything succeeded.
  if (path === "/api/agent-env/changes/preview" || path === "/api/agent-env/changes/apply") {
    const changes = parseAgentEnvChanges(init);
    const summaries = changes.map(
      (change) =>
        `${change.action === "remove" ? "Remove" : change.action === "copy" ? "Copy" : "Move"} ${
          change.category === "mcp" ? "MCP" : change.category
        } "${change.name}" (demo — nothing is written)`,
    );
    if (path.endsWith("/preview")) {
      return json({
        ok: true,
        valid: true,
        items: changes.map((change, index) => ({
          change,
          ok: true,
          summary: summaries[index],
          warnings: [],
        })),
        agents: [],
      });
    }
    return json({
      ok: true,
      applied: changes.length,
      failed: 0,
      results: changes.map((change, index) => ({
        change,
        ok: true,
        summary: summaries[index],
        backups: ["/Users/demo/.claude.json.bak.20260706-090000"],
      })),
      backups: ["/Users/demo/.claude.json.bak.20260706-090000"],
    });
  }
  if (path === "/api/agent-env/snapshot") {
    return json({ ok: true, agent: "claude", backups: ["/Users/demo/.claude.json.bak.20260706-090000"] });
  }

  // Profile registry (ROR-63). GET /auth/status is read-on-mount; the rest
  // back the registry bar's click actions with plausible demo data.
  if (path === "/api/agent-env/auth/status") {
    return json({
      ok: true,
      signedIn: true,
      source: "config",
      user: { email: "demo@nomoreide.dev", displayName: "Demo User" },
      apiBaseUrl: "https://api.brainctl.net",
      apiMode: "prod",
      apiSource: "default",
      apiFrontendUrl: "https://www.brainctl.net",
    });
  }
  if (path === "/api/agent-env/auth/start") {
    return json({ ok: true, url: "https://www.brainctl.net/cli-login", state: "demo-state" });
  }
  if (path === "/api/agent-env/auth/outcome") return json({ ok: true, status: "success" });
  if (path === "/api/agent-env/auth/logout") return json({ ok: true });
  if (path === "/api/agent-env/profiles/install-from-registry") {
    return json({
      ok: true,
      name: "registry-demo",
      mcpCount: 2,
      skillCount: 1,
      pluginCount: 1,
      missingCredentials: [],
      version: "1.0.0",
      sourceKind: "brainctl",
    });
  }
  if (path === "/api/agent-env/profiles/register-github") {
    return json({ ok: true, result: { slug: "demo-profile" } });
  }
  {
    const profilePublish = path.match(/^\/api\/agent-env\/profiles\/([^/]+)\/publish$/);
    if (profilePublish) {
      return json({
        ok: true,
        slug: decodeURIComponent(profilePublish[1]),
        profileId: "demo-profile-id",
        versionId: "demo-version-id",
        version: "1.0.0",
      });
    }
  }

  // Agent Profiles (ROR-62). GET /profiles is read-on-mount; the rest back
  // the panel's click actions with plausible demo data.
  if (path === "/api/agent-env/profiles" && method === "GET") {
    return json({ ok: true, profiles: agentEnvProfiles });
  }
  if (path === "/api/agent-env/profiles" && method === "POST") {
    return json({ ok: true, profile: { name: "new-profile", mcps: {}, skills: [] } });
  }
  if (path === "/api/agent-env/profiles/snapshot") {
    return json({
      ok: true,
      profile: {
        name: "snapshot-demo",
        description: "Demo snapshot",
        mcps: { github: { kind: "local", command: "npx", args: ["-y", "server-github"] } },
        skills: [{ name: "commit-push" }],
      },
    });
  }
  {
    // Agent settings dialog (fetch-on-open) + save/model-switch actions.
    const settingsMatch = path.match(/^\/api\/agent-env\/settings\/([^/]+)(\/model)?$/);
    if (settingsMatch) {
      const agent = settingsMatch[1];
      const format = agent === "codex" ? "toml" : "json";
      return json({
        ok: true,
        settings: {
          agent,
          path:
            agent === "codex"
              ? "~/.codex/config.toml"
              : agent === "claude"
                ? "~/.claude/settings.json"
                : "~/.gemini/settings.json",
          exists: true,
          format,
          content:
            format === "toml"
              ? 'model = "gpt-5-codex"\n\n[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "server-github"]\n'
              : '{\n  "model": "opus",\n  "permissions": {\n    "defaultMode": "acceptEdits"\n  }\n}\n',
          model: format === "toml" ? "gpt-5-codex" : "opus",
          modelEditable: agent !== "antigravity",
        },
        backup: null,
      });
    }
  }
  {
    // GET (expand-to-view) and PATCH (inline edit) of a single profile.
    const profileExact = path.match(/^\/api\/agent-env\/profiles\/([^/]+)$/);
    if (profileExact && (method === "GET" || method === "PATCH")) {
      const name = decodeURIComponent(profileExact[1]);
      const summary = agentEnvProfiles.find((profile) => profile.name === name);
      return json({
        ok: true,
        profile: {
          name,
          description: summary?.description,
          sourceAgent: (summary as { sourceAgent?: string } | undefined)?.sourceAgent,
          mcps: {
            github: { kind: "local", command: "npx", args: ["-y", "server-github"] },
            linear: { kind: "remote", transport: "http", url: "https://mcp.linear.app/mcp" },
          },
          skills: [{ name: "commit-push" }],
          plugins: [],
        },
      });
    }
  }
  if (path === "/api/agent-env/profiles/import") {
    return json({ ok: true, name: "imported-demo", mcpCount: 2, skillCount: 1, pluginCount: 0, missingCredentials: [] });
  }
  {
    const profileAction = path.match(/^\/api\/agent-env\/profiles\/([^/]+)\/(apply-preview|apply|export)$/);
    if (profileAction) {
      const [, name, action] = profileAction;
      if (action === "apply-preview") {
        return json({
          ok: true,
          profile: decodeURIComponent(name),
          agent: "codex",
          items: [
            { category: "mcp", name: "github", status: "add", warnings: [] },
            { category: "mcp", name: "linear", status: "conflict", warnings: [] },
            { category: "skill", name: "commit-push", status: "identical", warnings: [] },
          ],
          unresolvedCredentials: [],
        });
      }
      if (action === "apply") {
        return json({
          ok: true,
          profile: decodeURIComponent(name),
          agent: "codex",
          mcpsApplied: ["github"],
          skillsApplied: ["commit-push"],
          pluginsApplied: [],
          skipped: ['mcp "linear"'],
          backups: ["/Users/demo/.codex/config.toml.bak.20260706-090000"],
        });
      }
      return json({ ok: true, archivePath: `/Users/demo/projects/acme/${decodeURIComponent(name)}.tar.gz`, credentials: [] });
    }
  }
  {
    const profileDetail = path.match(/^\/api\/agent-env\/profiles\/([^/]+)$/);
    if (profileDetail) {
      if (method === "DELETE") return json({ ok: true });
      return json({
        ok: true,
        profile: {
          name: decodeURIComponent(profileDetail[1]),
          description: "Demo profile",
          mcps: {
            github: { kind: "local", command: "npx", args: ["-y", "server-github"] },
            docs: { kind: "remote", transport: "http", url: "https://developers.openai.com/mcp" },
          },
          skills: [{ name: "commit-push" }],
          plugins: [],
        },
      });
    }
  }

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
  if (path.match(/^\/api\/errors\/\d+\/fix$/)) {
    return json({
      ok: true,
      sessionId: "session-2026-demo",
      prompt: "Fix the placeholder-credential warning using the repro bundle context.",
      repoPath: "/Users/demo/projects/acme",
      snapshotSha: snapshots[0].sha,
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
  if (path === "/api/git/overview") {
    return json({
      ok: true,
      repos: [
        {
          name: "acme",
          path: "/Users/demo/projects/acme",
          branch: gitStatus.branch,
          ahead: gitStatus.ahead,
          behind: gitStatus.behind,
          files: gitFiles,
        },
      ],
      board: ["acme"],
    });
  }
  if (path === "/api/git/adopt" && method === "POST") {
    return json({ ok: true, name: "portfolio", path: "/home/demo/code/portfolio" });
  }
  if (path === "/api/git/create" && method === "POST") {
    return json({ ok: true, name: "new-project", path: "/home/demo/.nomoreide/repos/new-project" });
  }
  if (path === "/api/git/branches") {
    if (method === "POST") return json({ ok: true, output: "Created branch." });
    return json({
      ok: true,
      branches: [
        { name: "feat/website-real-ui-demo", current: true, remote: false, upstream: "origin/feat/website-real-ui-demo" },
        { name: "main", current: false, remote: false, upstream: "origin/main" },
      ],
    });
  }
  if (path === "/api/git/board") {
    const names = init?.body ? (JSON.parse(String(init.body)).names ?? ["acme"]) : ["acme"];
    return json({ ok: true, board: names });
  }
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

  // Event-driven workflow triggers (IDEAS #16). The demo has no live event
  // bus, so triggers/pending start empty — but the shapes must match so the
  // app-root WorkflowTriggerProvider doesn't choke on a missing array.
  if (path === "/api/workflow-triggers") {
    return json({ ok: true, triggers: workflowTriggers });
  }
  if (path === "/api/workflow-triggers/pending") {
    return json({ ok: true, pending: [] });
  }
  if (path.match(/^\/api\/workflow-triggers\/pending\/[^/]+\/ack$/)) {
    return json({ ok: true });
  }
  if (path.match(/^\/api\/workflow-triggers\/[^/]+$/)) {
    return json({ ok: true, triggers: workflowTriggers });
  }

  // Snapshots (IDEAS #6). List + per-snapshot files/diff/restore/rename/delete.
  if (path === "/api/snapshots") {
    if (method === "POST") {
      const created = {
        sha: `demo${Date.now().toString(16)}`.padEnd(40, "0"),
        ref: `refs/nomoreide/snapshots/${Date.now()}-manual-snapshot`,
        label: "manual snapshot",
        createdAt: new Date().toISOString(),
      };
      snapshots.unshift(created);
      return json({ ok: true, snapshot: created });
    }
    return json({ ok: true, snapshots });
  }
  const snapshotFilesMatch = path.match(/^\/api\/snapshots\/[^/]+\/files$/);
  if (snapshotFilesMatch) return json({ ok: true, files: snapshotFiles });
  if (path.match(/^\/api\/snapshots\/[^/]+\/diff$/)) {
    return text(diffs[url.searchParams.get("path") ?? ""] ?? "");
  }
  if (path.match(/^\/api\/snapshots\/[^/]+\/restore$/)) {
    return json({ ok: true, preRestore: snapshots[0], restoredFiles: snapshotFiles.length, deletedPaths: [] });
  }
  const snapshotMatch = path.match(/^\/api\/snapshots\/([^/]+)$/);
  if (snapshotMatch) {
    const target = snapshots.find((snap) => snap.sha === snapshotMatch[1]) ?? snapshots[0];
    return json({ ok: true, snapshot: target });
  }

  // Agent change-sets (IDEAS #11).
  if (path === "/api/agent/change-sets") {
    return json({ ok: true, sessions: changeSessions });
  }
  if (path.match(/^\/api\/agent\/change-sets\/[^/]+\/diff$/)) {
    return text(diffs[url.searchParams.get("path") ?? ""] ?? "");
  }
  if (path.match(/^\/api\/agent\/change-sets\/[^/]+\/restore$/)) {
    return json({ ok: true, preRestore: snapshots[0], restoredFiles: snapshotFiles.length, deletedPaths: [] });
  }
  if (path.match(/^\/api\/agent\/change-sets\/[^/]+$/)) {
    return json({ ok: true, session: changeSessions[0], files: snapshotFiles });
  }

  // Agent cost / run history (IDEAS #12).
  if (path === "/api/agent/usage/history") {
    return json({ ok: true, ...usageHistory });
  }

  // Service dependency graph (IDEAS #9) — structural only.
  if (path === "/api/services/graph") {
    return json({
      ok: true,
      graph: {
        nodes: serviceDefinitions.map((service) => ({
          name: service.name,
          dependsOn: service.name === "web-client" ? ["api"] : service.name === "api" ? ["worker"] : [],
          missing: [],
        })),
        edges: [
          { from: "worker", to: "api" },
          { from: "api", to: "web-client" },
        ],
        order: ["worker", "api", "web-client"],
        cycles: [],
      },
    });
  }

  if (path === "/api/github/token") {
    return json({
      ok: true,
      configured: true,
      deviceFlowAvailable: true,
      status: "connected",
      storedConfigured: true,
      repository: githubRepo,
      user: { login: "octocat", avatarUrl: "https://github.com/octocat.png?size=64" },
    });
  }
  if (path.startsWith("/api/github/oauth/")) {
    return json({ ok: true, done: path.endsWith("/poll") });
  }
  if (path === "/api/github/branches") {
    return json({ ok: true, ...githubBranchesPayload });
  }
  if (path === "/api/github/pr-template") {
    return json({
      ok: true,
      template: {
        repository: githubRepo,
        currentBranch: "feat/website-real-ui-demo",
        suggestedBase: "main",
        base: "main",
        head: "feat/website-real-ui-demo",
        title: "feat: mock real dashboard in website",
        body: "## Summary\nDemo PR drafted from website mock data.",
        draft: false,
        compare: {
          base: "main",
          head: "feat/website-real-ui-demo",
          aheadBy: 2,
          headSha: "a1b2c3d",
          commits: [{ sha: "a1b2c3d", message: "feat: mock real dashboard in website" }],
          files: gitFiles.map((file) => ({
            path: file.path,
            status: file.index === "A" ? "added" : "modified",
            additions: 12,
            deletions: 3,
            changes: 15,
          })),
        },
        warnings: [],
      },
    });
  }
  if (path === "/api/github/prs") {
    if (method === "POST") return json({ ok: true, pr: githubPrs[0] });
    return json({ ok: true, prs: githubPrs });
  }
  const githubPrReview = path.match(/^\/api\/github\/prs\/(\d+)\/review$/);
  if (githubPrReview) {
    const number = Number(githubPrReview[1]);
    const pr = githubPrs.find((item) => item.number === number) ?? githubPrs[0];
    return json({
      ok: true,
      cockpit: {
        pr,
        files: gitFiles.map((file) => ({
          path: file.path,
          status: file.index === "A" ? "added" : "modified",
          additions: 12,
          deletions: 3,
          changes: 15,
          blob_url: `${githubRepo.html_url}/blob/${pr.head.sha}/${file.path}`,
        })),
        reviews: [],
        comments: githubComments,
        checks: { sha: pr.head.sha, state: "failure" as const, totalCount: githubChecks.length, runs: githubChecks },
      },
    });
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
    const provider =
      mockAgentProviders.find((candidate) => candidate.id === mockAgentProviderId) ??
      mockAgentProviders[0];
    return json({
      ok: true,
      configured: true,
      approvals: false,
      provider,
      providers: mockAgentProviders,
    });
  }
  if (path === "/api/agent/chat/provider" && method === "POST") {
    const requested = parseJsonBody(init).provider;
    if (requested !== "claude" && requested !== "codex") {
      return json({ ok: false, error: "Unknown mocked agent provider." }, 400);
    }
    mockAgentProviderId = requested;
    const provider = mockAgentProviders.find(
      (candidate) => candidate.id === mockAgentProviderId,
    )!;
    return json({ ok: true, provider });
  }
  if (path === "/api/agent/chat") {
    const requested = parseJsonBody(init).provider;
    const provider =
      requested === "claude" || requested === "codex"
        ? requested
        : mockAgentProviderId;
    return agentStream(provider);
  }
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

  if (path === "/api/docker/status") {
    return json({ ok: true, status: { available: true, version: "27.3.1" } });
  }
  if (path === "/api/docker/containers") {
    return json({
      ok: true,
      containers: [
        {
          id: "8f2c1a9b3d4e",
          name: "app-api-1",
          image: "app-api",
          state: "running",
          status: "Up 2 hours",
          ports: "0.0.0.0:3000->3000/tcp",
          project: "app",
          service: "api",
        },
        {
          id: "1a7e5b6c2f90",
          name: "app-postgres-1",
          image: "postgres:16",
          state: "running",
          status: "Up 2 hours",
          ports: "0.0.0.0:5432->5432/tcp",
          project: "app",
          service: "postgres",
        },
        {
          id: "b4d9f0a1c2e3",
          name: "standalone-redis",
          image: "redis:7",
          state: "exited",
          status: "Exited (0) 3 days ago",
          ports: "",
        },
      ],
    });
  }
  if (path === "/api/docker/stats") {
    return json({
      ok: true,
      stats: [
        {
          id: "8f2c1a9b3d4e",
          cpuPercent: 2.4,
          memoryPercent: 9.1,
          memoryUsage: "184MiB / 2GiB",
          netIo: "1.2kB / 648B",
          blockIo: "0B / 4.1kB",
        },
        {
          id: "1a7e5b6c2f90",
          cpuPercent: 0.6,
          memoryPercent: 3.4,
          memoryUsage: "68MiB / 2GiB",
          netIo: "820B / 1.1kB",
          blockIo: "12MB / 3.2MB",
        },
      ],
    });
  }
  if (path === "/api/docker/images") {
    return json({
      ok: true,
      images: [
        {
          id: "sha256:a1b2c3d4",
          repository: "postgres",
          tag: "16",
          size: "417MB",
          createdSince: "2 days ago",
          dangling: false,
        },
        {
          id: "sha256:e5f6a7b8",
          repository: "node",
          tag: "22-alpine",
          size: "142MB",
          createdSince: "1 week ago",
          dangling: false,
        },
        {
          id: "sha256:c9d0e1f2",
          repository: "<none>",
          tag: "<none>",
          size: "88MB",
          createdSince: "3 weeks ago",
          dangling: true,
        },
      ],
    });
  }
  if (path === "/api/docker/volumes") {
    return json({
      ok: true,
      volumes: [
        {
          name: "app_pgdata",
          driver: "local",
          mountpoint: "/var/lib/docker/volumes/app_pgdata/_data",
          scope: "local",
        },
        {
          name: "app_redis",
          driver: "local",
          mountpoint: "/var/lib/docker/volumes/app_redis/_data",
          scope: "local",
        },
      ],
    });
  }
  if (path === "/api/docker/networks") {
    return json({
      ok: true,
      networks: [
        { id: "n1a2b3c4", name: "app_default", driver: "bridge", scope: "local" },
        { id: "n5d6e7f8", name: "bridge", driver: "bridge", scope: "local" },
        { id: "n9a0b1c2", name: "host", driver: "host", scope: "local" },
      ],
    });
  }
  if (path.match(/^\/api\/docker\/containers\/[^/]+\/inspect$/)) {
    return json({
      ok: true,
      detail: {
        id: "8f2c1a9b3d4e5a6b7c8d9e0f1a2b3c4d",
        name: "app-api-1",
        image: "app-api",
        command: "node dist/server.js",
        created: "2026-07-18T09:14:22.000Z",
        state: "running",
        startedAt: "2026-07-20T06:02:10.000Z",
        restartCount: 0,
        env: [
          { key: "NODE_ENV", value: "production", secret: false },
          { key: "PORT", value: "3000", secret: false },
          { key: "DATABASE_PASSWORD", value: "••••••••", secret: true },
        ],
        mounts: [
          {
            type: "volume",
            source: "app_pgdata",
            destination: "/var/lib/postgresql/data",
            readOnly: false,
          },
        ],
        ports: [{ containerPort: "3000/tcp", hostPort: "0.0.0.0:3000" }],
        networks: ["app_default"],
        labels: {
          "com.docker.compose.project": "app",
          "com.docker.compose.service": "api",
        },
      },
    });
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
      let agent: { provider?: "claude" | "codex"; prompt?: string; label?: string } | undefined;
      if (typeof init?.body === "string") {
        try {
          agent = (JSON.parse(init.body) as { agent?: typeof agent }).agent;
        } catch {
          // Keep the website demo responsive when a caller sends malformed JSON.
        }
      }
      if (agent?.provider && agent.prompt) {
        const session = {
          id: `demo-agent-${Date.now()}-${terminalSessions.length}`,
          cwd: terminalSessions[0]?.cwd ?? "/Users/demo/projects/acme",
          cols: 100,
          rows: 28,
          shell: agent.provider,
          provider: agent.provider,
          kind: "agent" as const,
          label: agent.label ?? `${agent.provider === "claude" ? "Claude" : "Codex"} agent`,
          state: "running" as const,
          prompt: agent.prompt,
        };
        terminalSessions = [...terminalSessions, session];
        return json({ ok: true, sessions: terminalSessions, session });
      }
      // No agent named → a plain shell, same as the server's `+` tab path.
      const session = {
        id: `demo-shell-${Date.now()}-${terminalSessions.length}`,
        cwd: terminalSessions[0]?.cwd ?? "/Users/demo/projects/acme",
        cols: 100,
        rows: 28,
        shell: "zsh",
        kind: "shell" as const,
        label: "shell",
        state: "running" as const,
      };
      terminalSessions = [...terminalSessions, session];
      return json({ ok: true, sessions: terminalSessions, session });
    }
    return json({ ok: true, sessions: terminalSessions, session: terminalSessions[0] });
  }
  const terminalSession = path.match(/^\/api\/terminal\/sessions\/([^/]+)$/);
  if (terminalSession) {
    const id = decodeURIComponent(terminalSession[1]);
    if (method === "PATCH") {
      let label = "";
      if (typeof init?.body === "string") {
        try {
          label = (JSON.parse(init.body) as { label?: string }).label?.trim() ?? "";
        } catch {
          // Match the real endpoint's validation response below.
        }
      }
      if (!label || label.length > 60) {
        return json(
          { ok: false, error: "Terminal session label must be 1–60 characters." },
          400,
        );
      }
      const index = terminalSessions.findIndex((session) => session.id === id);
      if (index < 0) {
        return json({ ok: false, error: `Unknown terminal session: ${id}` }, 404);
      }
      const session = { ...terminalSessions[index], label };
      terminalSessions = terminalSessions.map((item, itemIndex) =>
        itemIndex === index ? session : item,
      );
      return json({ ok: true, session });
    }
    if (method === "DELETE") {
      const before = terminalSessions.length;
      terminalSessions = terminalSessions.filter((session) => session.id !== id);
      return json({ ok: terminalSessions.length < before, sessions: terminalSessions });
    }
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
    if (path.endsWith("/env/runtime")) {
      return json({
        ok: true,
        runtime: {
          running: serviceStates[name] === "running",
          startedAt: serviceStates[name] === "running" ? startedAt : undefined,
          staleFiles: [],
          stale: false,
        },
      });
    }
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

  // Project assignment is a click-action returning only { ok }, but mocking it
  // explicitly keeps the demo console free of the unhandled-path warning below.
  if (/^\/api\/services\/[^/]+\/project$/.test(path)) {
    return json({ ok: true });
  }

  if (path === "/api/services" || path === "/api/bundles" || path === "/api/fs/directories") {
    return json({ ok: true, path: "/Users/demo/projects", parent: "/Users/demo", entries: [] });
  }

  // Any /api/* path that reaches here is unmocked. Most are click-actions that
  // are happy with a bare { ok: true }, but a *read* endpoint expecting a
  // specific field will hand the UI `undefined` and can white-screen the demo.
  // Surface it loudly in dev so a new dashboard feature's endpoint gets a mock
  // before it ships, instead of silently breaking the embedded app.
  if (import.meta.env?.DEV) {
    console.warn(`[website mock] unhandled ${method} ${path} — returning bare { ok: true }`);
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

function activityMetrics() {
  const now = Date.now();
  const hostSamples = Array.from({ length: 48 }, (_, index) => {
    const phase = index / 48;
    const cpuPercent = 31 + Math.sin(phase * Math.PI * 5) * 13;
    const memoryUsedPercent = 57 + Math.sin(phase * Math.PI * 2) * 3;
    return {
      t: now - (47 - index) * 3000,
      cpuPercent,
      memoryUsedBytes: (memoryUsedPercent / 100) * 16 * 1024 ** 3,
      memoryTotalBytes: 16 * 1024 ** 3,
      memoryUsedPercent,
      loadAverage: [2.1, 1.8, 1.4] as [number, number, number],
      uptimeSeconds: 60 * 60 * 9,
      logicalCpuCount: 8,
      disk: {
        path: "/Users/demo/projects/acme",
        totalBytes: 512 * 1024 ** 3,
        usedBytes: 286 * 1024 ** 3,
        availableBytes: 210 * 1024 ** 3,
        usedPercent: 55.9,
      },
    };
  });
  return {
    sampleIntervalMs: 3000,
    host: {
      current: hostSamples.at(-1) ?? null,
      samples: hostSamples,
    },
    services: Object.fromEntries(
      serviceDefinitions.flatMap((service) => {
        if (serviceStates[service.name] !== "running") return [];
        const series = metrics(service.name);
        const latest = series.samples.at(-1);
        if (!latest) return [];
        return [
          [
            service.name,
            {
              service: service.name,
              startedAt,
              sampledAt: latest.t,
              cpuPercent: latest.cpu,
              rssMb: latest.rss,
              processCount: 3,
            },
          ],
        ];
      }),
    ),
    systemProcesses: [
      {
        pid: 7421,
        ppid: 1,
        uid: 501,
        user: "demo",
        cpuPercent: 18.4,
        rssMb: 624,
        command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        canTerminate: true,
      },
      {
        pid: 8102,
        ppid: 1,
        uid: 501,
        user: "demo",
        cpuPercent: 7.2,
        rssMb: 318,
        command: "/Applications/Slack.app/Contents/MacOS/Slack",
        canTerminate: true,
      },
      {
        pid: 9020,
        ppid: 1,
        uid: 501,
        user: "demo",
        cpuPercent: 4.8,
        rssMb: 256,
        command: "node vite --host 127.0.0.1",
        managedService: "web-client",
        canTerminate: false,
        protection: "managed" as const,
      },
    ],
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

class WebsiteDemoWebSocket extends EventTarget {
  static readonly CLOSED = 3;
  static readonly CLOSING = 2;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;

  readonly url: string;
  readyState = WebsiteDemoWebSocket.CONNECTING;
  private inputBuffer = "";
  private transcriptSent = false;
  private readonly session?: DemoTerminalSession;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    const parsedUrl = new URL(this.url, window.location.href);
    const id =
      parsedUrl.pathname === "/api/terminal/socket"
        ? (parsedUrl.searchParams.get("id") ?? "")
        : "";
    this.session = terminalSessions.find((candidate) => candidate.id === id);

    window.setTimeout(() => {
      if (this.readyState !== WebsiteDemoWebSocket.CONNECTING) return;
      if (!this.session) {
        this.dispatchEvent(new Event("error"));
        this.close();
        return;
      }
      this.readyState = WebsiteDemoWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
      this.message({
        type: "state",
        state: "running",
        cwd: this.session.cwd,
        shell: this.session.provider === "claude" ? "Claude Code" : "Codex",
      });
      // Keep a fallback for browsers that do not notify ResizeObserver while
      // the embedded dock is clipped below the fold.
      window.setTimeout(() => this.sendTranscript(), 320);
    }, 20);
  }

  send(raw: string) {
    if (this.readyState !== WebsiteDemoWebSocket.OPEN) return;
    let message: { data?: string; rows?: number; type?: string };
    try {
      message = JSON.parse(String(raw)) as {
        data?: string;
        rows?: number;
        type?: string;
      };
    } catch {
      return;
    }

    // The dock mounts its xterms while collapsed. Wait until FitAddon reports a
    // useful viewport so the seeded transcript is visible when the human opens
    // the panel instead of being written into a zero-height terminal.
    if (
      message.type === "resize" &&
      (message.rows ?? 0) >= 4 &&
      !this.transcriptSent &&
      this.session
    ) {
      window.setTimeout(() => this.sendTranscript(), 80);
      return;
    }
    if (message.type === "stop") {
      this.message({ type: "state", state: "exited", cwd: this.session?.cwd });
      this.close();
      return;
    }
    if (message.type === "restart") {
      this.message({
        type: "output",
        data: "\r\n\x1b[2mRestarted mocked agent session.\x1b[0m\r\n",
      });
      return;
    }
    if (message.type !== "input" || typeof message.data !== "string") return;

    this.inputBuffer += message.data;
    if (!/[\r\n]/.test(message.data)) return;
    const prompt = this.inputBuffer.replace(/[\r\n]+/g, " ").trim();
    this.inputBuffer = "";
    if (!prompt) return;

    const provider = this.session?.provider ?? "codex";
    if (this.session?.id === "demo-claude-agent") {
      document
        .querySelector('[data-terminal-session="demo-claude-agent"]')
        ?.setAttribute("data-terminal-follow-up", "true");
    }
    window.setTimeout(() => {
      this.message({
        type: "output",
        data: websiteAgentFollowUp(provider, prompt),
      });
    }, 180);
  }

  close() {
    if (
      this.readyState === WebsiteDemoWebSocket.CLOSED ||
      this.readyState === WebsiteDemoWebSocket.CLOSING
    ) {
      return;
    }
    this.readyState = WebsiteDemoWebSocket.CLOSING;
    window.setTimeout(() => {
      this.readyState = WebsiteDemoWebSocket.CLOSED;
      this.dispatchEvent(new Event("close"));
    }, 0);
  }

  private message(payload: unknown) {
    if (this.readyState !== WebsiteDemoWebSocket.OPEN) return;
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(payload) }),
    );
  }

  private sendTranscript() {
    if (this.transcriptSent || !this.session) return;
    this.transcriptSent = true;
    this.message({
      type: "output",
      data: websiteAgentTranscript(this.session),
    });
  }
}

function websiteAgentTranscript(session: DemoTerminalSession): string {
  const prompt = session.prompt ?? "Inspect this mocked project.";
  if (session.provider === "claude") {
    return [
      "       \x1b[1mClaude Code\x1b[0m  \x1b[2mv2.1.220\x1b[0m",
      "       \x1b[2mOpus 5 with high effort · website demo\x1b[0m",
      "       \x1b[2m~/projects/acme\x1b[0m",
      `\x1b[1m❯\x1b[0m ${prompt}`,
      "\x1b[38;5;173m⏺\x1b[0m Read(src/core/worker-health.ts)  \x1b[2m⎿  84 lines\x1b[0m",
      "\x1b[38;5;173m⏺\x1b[0m Bash(npm test -- worker-health)  \x1b[2m⎿  12 tests passed\x1b[0m",
      "The worker is healthy at the process level, but its queue check is",
      "failing because \x1b[36mQUEUE_URL\x1b[0m contains the demo placeholder.",
      "\x1b[32mNo restart yet.\x1b[0m I’d correct that environment value, re-run the",
      "health check, then restart only the worker if it stays unhealthy.",
      "\x1b[2m────────────────────────────────────────────────────────────\x1b[0m",
      "\x1b[1m❯\x1b[0m \x1b[2mAsk a follow-up…\x1b[0m",
      "\x1b[2m  acme git:(main) · clean\x1b[0m",
      "",
    ].join("\r\n");
  }
  return [
    "\x1b[2m╭────────────────────────────────────────────────────────╮\x1b[0m",
    "\x1b[2m│\x1b[0m \x1b[1m>_ OpenAI Codex\x1b[0m  \x1b[2m(v0.146.0)                            │\x1b[0m",
    "\x1b[2m│                                                        │\x1b[0m",
    "\x1b[2m│ model:     \x1b[0mgpt-5.6-sol medium    \x1b[36m/model\x1b[0m \x1b[2mto change    │\x1b[0m",
    "\x1b[2m│ directory: \x1b[0m~/projects/acme                 \x1b[2m          │\x1b[0m",
    "\x1b[2m╰────────────────────────────────────────────────────────╯\x1b[0m",
    "",
    "\x1b[1mTip:\x1b[0m \x1b[2mwebsite demo data only; commands and results are fictional.\x1b[0m",
      "",
    `\x1b[1m›\x1b[0m ${prompt}`,
      "",
    "\x1b[1m•\x1b[0m Explored",
    "  \x1b[2m└ Ran git status --short\x1b[0m",
    "    \x1b[2mRead the staged diff and secret-redaction tests\x1b[0m",
    "",
    "\x1b[1m•\x1b[0m Ran npm test -- --run secret-redaction",
    "  \x1b[2m└ 18 tests passed\x1b[0m",
      "",
    "\x1b[1m•\x1b[0m Review complete. The changed values are explicit demo placeholders,",
    "  and the redaction boundary remains covered. I found no real credentials.",
    "",
    "\x1b[1m›\x1b[0m \x1b[2mAsk a follow-up…\x1b[0m",
    "\x1b[2m  acme · main · No changes · Context 4% used\x1b[0m",
      "",
  ].join("\r\n");
}

function websiteAgentFollowUp(
  provider: "claude" | "codex",
  prompt: string,
): string {
  if (provider === "claude") {
    return [
      "",
      `\x1b[1m❯\x1b[0m ${prompt}`,
      "",
      "\x1b[38;5;173m⏺\x1b[0m Read(recent worker logs)",
      "  \x1b[2m⎿  24 lines\x1b[0m",
      "",
      "The logs confirm the process is stable; only the mocked queue check",
      "is failing. I would update that value and verify before restarting.",
      "",
      "\x1b[2m────────────────────────────────────────────────────────────\x1b[0m",
      "\x1b[1m❯\x1b[0m \x1b[2mAsk a follow-up…\x1b[0m",
      "",
    ].join("\r\n");
  }
  return [
    "",
    `\x1b[1m›\x1b[0m ${prompt}`,
    "",
    "\x1b[1m•\x1b[0m Explored",
    "  \x1b[2m└ Re-read the focused diff and its regression test\x1b[0m",
    "",
    "\x1b[1m•\x1b[0m The focused check is the right next step. It keeps the change",
    "  reviewable and exercises the credential-safety boundary directly.",
    "",
    "\x1b[1m›\x1b[0m \x1b[2mAsk a follow-up…\x1b[0m",
    "\x1b[2m  acme · main · No changes · Context 6% used\x1b[0m",
    "",
  ].join("\r\n");
}

function agentStream(provider: "claude" | "codex"): Response {
  const encoder = new TextEncoder();
  const label = provider === "claude" ? "Claude Code" : "Codex";
  const events = [
    { type: "session", sessionId: `website-demo-${provider}-session` },
    { type: "text", text: `${label} checked the mocked services, placeholder env, and git diff. ` },
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

interface MockAgentEnvChange {
  category: "mcp" | "skill" | "plugin";
  action: "copy" | "move" | "remove";
  name: string;
}

function parseAgentEnvChanges(init?: RequestInit): MockAgentEnvChange[] {
  try {
    const body = JSON.parse(String(init?.body ?? "{}")) as { changes?: MockAgentEnvChange[] };
    return Array.isArray(body.changes) ? body.changes : [];
  } catch {
    return [];
  }
}

function parseJsonBody(init?: RequestInit): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(init?.body ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
