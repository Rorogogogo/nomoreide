import { useState } from "react";
import {
  ArrowLeft,
  Bot,
  BookOpen,
  Copy,
  ExternalLink,
  ShieldCheck,
  Terminal,
  Wrench,
} from "lucide-react";
import { Button } from "./ui/button";

const claudeSetup =
  "claude mcp add --transport stdio nomoreide -- npx -y nomoreide";
const codexSetup = "codex mcp add nomoreide -- npx -y nomoreide";
const recommendedSetup = `npx -y nomoreide setup codex
npx -y nomoreide setup claude
npx -y nomoreide setup gemini`;
const geminiSetup = `{
  "mcpServers": {
    "nomoreide": {
      "command": "npx",
      "args": ["-y", "nomoreide"]
    }
  }
}`;

const setupPrompt =
  "Please set up NoMoreIDE as a local MCP server for this agent. Register a server named nomoreide that runs npx -y nomoreide. After adding it, tell me how to verify it with /mcp, then open the Web UI at http://127.0.0.1:4317/.";

const sessionPrompt =
  "Use NoMoreIDE as the shared local workbench for this session. Start by calling nomoreide_list_services and nomoreide_status. Before changing service state, check nomoreide_service_health and recent logs. For Git and GitHub work, inspect status, diffs, PRs, issues, and CI before staging, committing, or merging. For database work, keep MCP queries read-only; return one statement in a standard sql fence, identify the target connection, and direct the human to review it in the locked Web UI SQL console.";

const localServiceCommand = `nomoreide add service backend \\
  --command "npm run dev" \\
  --cwd /absolute/path/to/backend \\
  --port 3001`;

const gitCommands = `nomoreide git status --cwd /path/to/repo
nomoreide git diff --cwd /path/to/repo
nomoreide git stage --cwd /path/to/repo src/index.ts README.md
nomoreide git unstage --cwd /path/to/repo src/index.ts
nomoreide git commit --cwd /path/to/repo --message "feat: add dashboard"
nomoreide git log --cwd /path/to/repo
nomoreide git fetch --cwd /path/to/repo
nomoreide git create-branch --cwd /path/to/repo feature/new-work`;

const developmentCommands = `npm install
npm run dev
npm run dev:web
npm test
npm run build
npm --prefix website run build`;

const serviceTools = [
  "nomoreide_list_services",
  "nomoreide_register_service",
  "nomoreide_start_service",
  "nomoreide_stop_service",
  "nomoreide_restart_service",
  "nomoreide_read_logs",
  "nomoreide_register_bundle",
  "nomoreide_start_bundle",
  "nomoreide_stop_bundle",
  "nomoreide_status",
  "nomoreide_service_context",
  "nomoreide_service_health",
  "nomoreide_timeline",
];

const gitTools = [
  "nomoreide_git_status",
  "nomoreide_git_branches",
  "nomoreide_git_switch_branch",
  "nomoreide_git_create_branch",
  "nomoreide_git_fetch",
  "nomoreide_git_diff",
  "nomoreide_git_staged_diff",
  "nomoreide_git_log",
  "nomoreide_git_stage",
  "nomoreide_git_unstage",
  "nomoreide_git_commit",
  "nomoreide_git_push",
  "nomoreide_git_clone",
  "nomoreide_git_register_repository",
  "nomoreide_git_select_repository",
  "nomoreide_git_worktrees",
  "nomoreide_git_create_worktree",
  "nomoreide_git_select_worktree",
  "nomoreide_git_prune_worktrees",
];

const snapshotTools = [
  "nomoreide_snapshots_list",
  "nomoreide_snapshot_create",
];

const databaseTools = [
  "nomoreide_list_databases",
  "nomoreide_register_database",
  "nomoreide_check_database",
  "nomoreide_db_schemas",
  "nomoreide_db_objects",
  "nomoreide_db_object_details",
  "nomoreide_db_tables",
  "nomoreide_db_sample",
  "nomoreide_db_query",
];

const vercelTools = [
  "nomoreide_vercel_list_projects",
  "nomoreide_vercel_list_deployments",
  "nomoreide_vercel_get_deployment",
  "nomoreide_vercel_deployment_logs",
];

const agentEnvironmentTools = [
  "nomoreide_agents_status",
  "nomoreide_agents_read_configs",
  "nomoreide_agents_doctor",
  "nomoreide_agents_add_mcp",
  "nomoreide_agents_remove_mcp",
  "nomoreide_agents_move_mcp_scope",
  "nomoreide_agents_move_skill_scope",
  "nomoreide_agents_snapshot_agent",
];

const profileTools = [
  "nomoreide_profiles_list",
  "nomoreide_profiles_get",
  "nomoreide_profiles_create",
  "nomoreide_profiles_update",
  "nomoreide_profiles_delete",
  "nomoreide_profiles_snapshot",
  "nomoreide_profiles_apply",
  "nomoreide_profiles_export",
  "nomoreide_profiles_import",
  "nomoreide_profiles_copy_items",
  "nomoreide_profiles_publish",
  "nomoreide_profiles_install_from_registry",
  "nomoreide_profiles_register_github",
];

const toolGroups = [
  { title: "Service tools", tools: serviceTools },
  { title: "Repo onboarding", tools: ["nomoreide_onboard_repo"] },
  { title: "Git tools", tools: gitTools },
  { title: "Snapshots", tools: snapshotTools },
  { title: "Error tools", tools: ["nomoreide_list_errors", "nomoreide_error_prompt"] },
  { title: "Database tools", tools: databaseTools },
  {
    title: "GitHub tools",
    tools: [
      "nomoreide_github_set_token",
      "nomoreide_github_list_prs",
      "nomoreide_github_get_pr",
      "nomoreide_github_get_pr_diff",
      "nomoreide_github_create_pr",
      "nomoreide_github_merge_pr",
      "nomoreide_github_list_issues",
      "nomoreide_github_get_issue",
      "nomoreide_github_list_issue_comments",
      "nomoreide_github_add_issue_comment",
      "nomoreide_github_create_issue",
      "nomoreide_github_get_commit_ci",
      "nomoreide_github_list_workflow_runs",
    ],
  },
  { title: "Vercel tools", tools: vercelTools },
  { title: "Documentation", tools: ["nomoreide_docs"] },
  { title: "Agent and UI", tools: ["nomoreide_open_ui", "nomoreide_close_ui"] },
  { title: "Agent environments", tools: agentEnvironmentTools },
  { title: "Agent profiles and registry", tools: profileTools },
];

const toc = [
  ["overview", "Overview"],
  ["mcp-setup", "MCP Setup"],
  ["interfaces", "Interfaces"],
  ["cli", "CLI"],
  ["dashboard", "Dashboard"],
  ["mcp-tools", "MCP Tools"],
  ["configuration", "Configuration"],
  ["safety", "Safety"],
  ["ai-agent-guide", "AI Guide"],
  ["troubleshooting", "Troubleshooting"],
  ["architecture", "Architecture"],
  ["development", "Development"],
  ["license", "License"],
] as const;

export function DocsPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <a
            className="inline-flex items-center gap-2 text-sm text-muted-foreground transition hover:text-foreground"
            href="/"
          >
            <ArrowLeft className="size-4" />
            NoMoreIDE
          </a>
          <nav className="flex flex-wrap items-center gap-2 text-sm">
            <a
              className="rounded-md px-3 py-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              href="/llms.txt"
            >
              llms.txt
            </a>
            <a
              className="rounded-md px-3 py-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              href="/llms-full.txt"
            >
              Full AI docs
            </a>
            <Button asChild size="sm" variant="outline">
              <a href="https://github.com/Rorogogogo/nomoreide">
                GitHub
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
          </nav>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[240px_minmax(0,1fr)] lg:py-14">
        <aside className="hidden lg:block">
          <div className="sticky top-20">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Documentation
            </p>
            <nav className="mt-4 grid gap-1">
              {toc.map(([href, label]) => (
                <a
                  className="rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  href={`#${href}`}
                  key={href}
                >
                  {label}
                </a>
              ))}
            </nav>
          </div>
        </aside>

        <div className="min-w-0">
          <section className="border-b border-border pb-10">
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <BookOpen className="size-4" />
              Reviewed for v0.1.99 · August 2026
            </div>
            <h1 className="mt-4 max-w-4xl text-4xl font-semibold tracking-tight md:text-6xl">
              NoMoreIDE documentation
            </h1>
            <p className="mt-5 max-w-3xl text-lg leading-8 text-muted-foreground">
              Use NoMoreIDE as a local workbench for services, logs, Git review,
              database inspection, terminal access, and MCP workflows. This page
              is written for people; the linked text files are stable targets for
              AI agents.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild>
                <a href="#mcp-setup">Set up MCP</a>
              </Button>
              <Button asChild variant="outline">
                <a href="/docs/ai-guide.md">AI agent guide</a>
              </Button>
              <Button asChild variant="ghost">
                <a href="/llms-full.txt">Fetch full text docs</a>
              </Button>
            </div>
          </section>

          <Section
            eyebrow="Concept"
            icon={<BookOpen className="size-5" />}
            id="overview"
            title="Overview"
          >
            <p>
              NoMoreIDE gives coding agents and humans a shared local control
              surface. It runs as a stdio MCP server, CLI, TUI, and local web
              or macOS desktop dashboard, all backed by the same service, log,
              Git, GitHub, Vercel, database, workflow, and diagnostic modules.
            </p>
            <InfoGrid
              items={[
                ["For agents", "Structured MCP tools replace guesswork and broad shell access."],
                ["For humans", "The dashboard keeps services, logs, diffs, data, and terminal work visible."],
                ["For teams", "Registered services and repositories make local workflows repeatable."],
              ]}
            />
          </Section>

          <Section
            eyebrow="Agents"
            icon={<Bot className="size-5" />}
            id="mcp-setup"
            title="MCP Setup"
          >
            <p>
              The recommended setup installs both the local stdio MCP server and
              the <code>nomoreide-debug</code> skill. Start a new agent session,
              then verify the server with <code>/mcp</code>. Use the manual
              commands below when you only want the MCP connection.
            </p>
            <CodeBlock code={recommendedSetup} />
            <CodeBlock code={claudeSetup} />
            <CodeBlock code={codexSetup} />
            <CodeBlock code={geminiSetup} language="json" />
            <CodeBlock code={setupPrompt} language="prompt" />
          </Section>

          <Section
            eyebrow="Runtime"
            icon={<Terminal className="size-5" />}
            id="interfaces"
            title="Running Interfaces"
          >
            <InfoGrid
              items={[
                ["MCP server", "`nomoreide` starts the stdio server for connected agents."],
                ["Terminal UI", "`nomoreide tui` opens the terminal interface."],
                ["Web dashboard", "`nomoreide web` serves `http://127.0.0.1:4317` by default."],
                ["macOS desktop", "Download the standalone app from GitHub Releases for a native dashboard without a separate Node backend."],
              ]}
            />
            <CodeBlock code={`nomoreide
nomoreide tui
nomoreide web
nomoreide web --port=4320`} />
          </Section>

          <Section
            eyebrow="Commands"
            icon={<Terminal className="size-5" />}
            id="cli"
            title="CLI Reference"
          >
            <p>
              The CLI covers setup guidance, web and TUI launch, service
              registration, bundle orchestration, logs, and safe Git operations.
            </p>
            <CodeBlock code={localServiceCommand} />
            <CodeBlock
              code={`nomoreide add bundle full-stack db backend frontend
nomoreide list
nomoreide start backend
nomoreide stop backend
nomoreide restart backend
nomoreide logs backend`}
            />
            <CodeBlock code={gitCommands} />
          </Section>

          <Section
            eyebrow="Product"
            icon={<Wrench className="size-5" />}
            id="dashboard"
            title="Web Dashboard Guide"
          >
            <InfoGrid
              items={[
                ["Services", "Register local, Docker Compose, and SSH-backed services; start, stop, restart, and inspect health."],
                ["Activity", "Monitor process CPU, memory, energy impact, ports, and runtime health across projects."],
                ["Docker", "Inspect containers, images, volumes, networks, Compose projects, logs, and resource details."],
                ["Git Review", "Review multiple repositories, clone projects, manage branches and worktrees, inspect diffs/history, and create safe snapshots."],
                ["GitHub", "Switch accounts and review PRs, issues, comments, CI status, branches, and Actions workflow runs."],
                ["Vercel", "Inspect linked projects, deployments, production state, build logs, and all-project status; dashboard-only controls handle deployment mutations."],
                ["Workflows", "Run commit/push/ship flows or author action, isolated-agent, approval-gate, resumable, and event-triggered workflows."],
                ["Error Inbox", "Review deduplicated incidents and move through snapshot, agent fix, and reviewable change-set loops."],
                ["Database", "Browse schemas and database objects, inspect definitions, query data, generate SQL, and gate writes behind unlock, preview, and commit."],
                ["Terminal", "Use project shells, split agent task terminals, and a draggable bottom or side agent dock."],
                ["Agent Environments", "Inspect and move MCPs, skills, and plugins; snapshot, apply, export, publish, and install portable profiles."],
                ["Settings", "Search global and project-scoped preferences, including language, theme, accent, runtime, and agent configuration."],
              ]}
            />
          </Section>

          <Section
            eyebrow="Reference"
            icon={<Bot className="size-5" />}
            id="mcp-tools"
            title="MCP Tool Reference"
          >
            <p>
              All NoMoreIDE MCP tools are grouped by domain and prefixed with
              <code> nomoreide_</code>.
            </p>
            <div className="grid gap-4">
              {toolGroups.map((group) => (
                <div className="rounded-lg border border-border p-4" key={group.title}>
                  <h3 className="font-semibold">{group.title}</h3>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {group.tools.map((tool) => (
                      <code
                        className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
                        key={tool}
                      >
                        {tool}
                      </code>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <Section
            eyebrow="State"
            icon={<Wrench className="size-5" />}
            id="configuration"
            title="Configuration Model"
          >
            <p>
              NoMoreIDE stores global config at
              <code> ~/.config/nomoreide/config.json</code>. Configuration is
              Zod-validated and organized around registered resources.
            </p>
            <InfoGrid
              items={[
                ["services", "Local, Docker Compose, and SSH-backed service definitions."],
                ["bundles", "Ordered groups of service names."],
                ["gitRepositories", "Named Git worktree paths."],
                ["databases", "Postgres, MySQL, and SQLite connection definitions."],
                ["logSources", "File, SSH, command, journald, or Docker log readers."],
                ["selectedGitRepository", "The active repository shown by the dashboard."],
                ["githubTokens / githubIdentities", "Per-host tokens and selectable GitHub author/account identities."],
                ["vercel", "The selected Vercel authentication scope and team connection."],
                ["workflows", "Saved action, agent, and approval-gate workflows."],
                ["workflowTriggers", "Event bindings that automatically start saved workflows."],
              ]}
            />
          </Section>

          <Section
            eyebrow="Boundaries"
            icon={<ShieldCheck className="size-5" />}
            id="safety"
            title="Safety Model"
          >
            <ul className="grid gap-3">
              {[
                "No broad filesystem scanning.",
                "No killing external processes that NoMoreIDE did not start.",
                "Port conflicts are reported instead of forcefully resolved.",
                "Git tools omit hard reset, clean, force push, and branch deletion.",
                "Git staging requires explicit file paths.",
                "Database MCP tools are read-only; writes are staged for the human-only SQL console.",
                "Database writes require an explicit unlock and affected-rows preview before commit.",
                "GitHub merge and comment tools require a configured token and explicit user intent.",
                "Vercel MCP tools are read-only; redeploy, cancel, promote, and rollback stay in the human dashboard.",
                "Agent environment changes create backups and profile credentials are redacted before export or publish.",
                "SSH services rely on the user's local SSH config and ssh-agent.",
                "Managed service logs are scoped to .nomoreide/logs/.",
              ].map((item) => (
                <li className="flex gap-3" key={item}>
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-green-500" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section
            eyebrow="AI"
            icon={<Bot className="size-5" />}
            id="ai-agent-guide"
            title="AI Agent Guide"
          >
            <p>
              Agents should start by discovering registered context, then use the
              narrowest NoMoreIDE tool that matches the task.
            </p>
            <CodeBlock code={sessionPrompt} language="prompt" />
            <InfoGrid
              items={[
                ["Service debugging", "Call health, logs, and timeline before restart decisions."],
                ["Git review", "Inspect status and diffs before staging or committing."],
                ["GitHub review", "Check PRs, issues, CI, and workflow runs before merge decisions."],
                ["Database inspection", "List connections, list tables, sample rows, and keep MCP queries read-only."],
                ["Database writes", "Return one statement in a standard SQL fence, identify the connection, and direct the human to the locked SQL console for preview and commit."],
              ]}
            />
          </Section>

          <Section
            eyebrow="Help"
            icon={<Wrench className="size-5" />}
            id="troubleshooting"
            title="Troubleshooting"
          >
            <InfoGrid
              items={[
                ["MCP missing", "Re-run setup, restart the agent, verify with /mcp, and confirm npx -y nomoreide works."],
                ["Node issue", "Use Node.js 20 or newer, or install globally with npm install -g nomoreide."],
                ["Port conflict", "Use nomoreide web --port=4320 or inspect the process on 4317."],
                ["Service failure", "Check absolute cwd, command validity, service health, logs, and timeline."],
                ["Git missing", "Register an absolute Git worktree path before using repository tools."],
                ["Database failure", "Verify URL, network reachability, and least-privilege credentials."],
              ]}
            />
          </Section>

          <Section
            eyebrow="Internals"
            icon={<Wrench className="size-5" />}
            id="architecture"
            title="Architecture"
          >
            <InfoGrid
              items={[
                ["Core", "ConfigStore, ProcessManager, LogStore, GitManager, ServiceHealth, TimelineStore, DbPeek, and ErrorInbox."],
                ["MCP", "FastMCP stdio server with domain-specific tool modules."],
                ["Web", "Local HTTP server plus route registry under src/web/routes/."],
                ["Dashboard", "React, Vite, Tailwind CSS, and feature modules under src/web/client/src/features/."],
              ]}
            />
            <CodeBlock
              code={`AI agent -> MCP stdio -> NoMoreIDE tools -> core managers
Human -> CLI/TUI/Web dashboard -> same core managers`}
              language="text"
            />
          </Section>

          <Section
            eyebrow="Contribute"
            icon={<Terminal className="size-5" />}
            id="development"
            title="Development"
          >
            <p>Use the root package for the CLI, MCP server, and local dashboard. Use the `website` package for the public landing site.</p>
            <CodeBlock code={developmentCommands} />
          </Section>

          <Section
            eyebrow="Terms"
            icon={<ShieldCheck className="size-5" />}
            id="license"
            title="License"
          >
            <p>
              NoMoreIDE is AGPL-3.0 licensed with a commercial license available
              for closed-source products, proprietary internal tools, and hosted
              services where AGPL obligations do not fit.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button asChild variant="outline">
                <a href="https://github.com/Rorogogogo/nomoreide/blob/main/LICENSE">
                  License
                </a>
              </Button>
              <Button asChild variant="outline">
                <a href="https://github.com/Rorogogogo/nomoreide/blob/main/COMMERCIAL.md">
                  Commercial license
                </a>
              </Button>
            </div>
          </Section>
        </div>
      </main>
    </div>
  );
}

function Section({
  children,
  eyebrow,
  icon,
  id,
  title,
}: {
  children: React.ReactNode;
  eyebrow: string;
  icon: React.ReactNode;
  id: string;
  title: string;
}) {
  return (
    <section className="scroll-mt-24 border-b border-border py-10" id={id}>
      <div className="mb-5 flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-md border border-border bg-muted/40">
          {icon}
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {eyebrow}
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight md:text-3xl">
            {title}
          </h2>
        </div>
      </div>
      <div className="grid gap-5 text-sm leading-7 text-muted-foreground md:text-base">
        {children}
      </div>
    </section>
  );
}

function InfoGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-2">
      {items.map(([title, body]) => (
        <div className="bg-background p-4" key={title}>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{body}</p>
        </div>
      ))}
    </div>
  );
}

function CodeBlock({
  code,
  language = "bash",
}: {
  code: string;
  language?: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          {language}
        </span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-4 text-sm leading-6 text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <button
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
      onClick={copy}
      type="button"
    >
      <Copy className="size-3.5" />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
