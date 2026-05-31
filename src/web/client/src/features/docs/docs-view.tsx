import {
  Bot,
  BookOpen,
  ExternalLink,
  ShieldCheck,
  Terminal,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const docsLinks = [
  {
    title: "Human documentation",
    href: "https://www.nomoreide.com/docs",
    body: "Full guide for setup, CLI usage, MCP tools, dashboard workflows, safety, and troubleshooting.",
  },
  {
    title: "llms.txt",
    href: "https://www.nomoreide.com/llms.txt",
    body: "Short AI-readable index with the highest-value setup links and commands.",
  },
  {
    title: "Full AI docs",
    href: "https://www.nomoreide.com/llms-full.txt",
    body: "Plain-text documentation optimized for agents to fetch and reason over.",
  },
  {
    title: "AI agent guide",
    href: "https://www.nomoreide.com/docs/ai-guide.md",
    body: "Markdown workflow guide for agents using NoMoreIDE through MCP.",
  },
];

const setupCommands = `claude mcp add --transport stdio nomoreide -- npx -y nomoreide
codex mcp add nomoreide -- npx -y nomoreide`;

const agentPrompt =
  "Use NoMoreIDE as the shared local workbench for this session. Start by calling nomoreide_list_services and nomoreide_status. Before changing service state, check nomoreide_service_health and recent logs. For Git work, inspect status and diffs before staging or committing.";

export function DocsView() {
  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-6 md:px-8">
        <section className="grid gap-4 border-b border-border pb-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <BookOpen className="size-4" />
            Product documentation
          </div>
          <div className="grid gap-3">
            <h2 className="max-w-3xl text-3xl font-semibold tracking-tight">
              Documentation, setup prompts, and AI-fetchable guides.
            </h2>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              This page gives the local dashboard a direct docs entry point. Use
              it while working in the product, or hand the AI-readable links to
              an agent that needs a stable source of truth.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <a href="https://www.nomoreide.com/docs" rel="noreferrer" target="_blank">
                Open docs
                <ExternalLink />
              </a>
            </Button>
            <Button asChild variant="outline">
              <a
                href="https://www.nomoreide.com/docs/ai-guide.md"
                rel="noreferrer"
                target="_blank"
              >
                AI guide
                <ExternalLink />
              </a>
            </Button>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          {docsLinks.map((link) => (
            <a
              className="group rounded-lg border border-border bg-card p-5 transition hover:border-foreground/30 hover:bg-muted/30"
              href={link.href}
              key={link.href}
              rel="noreferrer"
              target="_blank"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-semibold">{link.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {link.body}
                  </p>
                </div>
                <ExternalLink className="size-4 shrink-0 text-muted-foreground transition group-hover:text-foreground" />
              </div>
            </a>
          ))}
        </section>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <GuidePanel
            icon={<Terminal className="size-5" />}
            title="MCP setup"
          >
            <p>
              Add NoMoreIDE as a local stdio MCP server, restart your agent if
              needed, then verify with <code>/mcp</code>.
            </p>
            <CodeBlock code={setupCommands} />
          </GuidePanel>

          <GuidePanel icon={<Bot className="size-5" />} title="Agent prompt">
            <p>
              Paste this when you want an agent to use the local dashboard as
              the source of runtime context.
            </p>
            <CodeBlock code={agentPrompt} />
          </GuidePanel>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          <QuickReference
            icon={<Wrench className="size-5" />}
            title="Use the dashboard"
            body="Register services, inspect health, tail logs, review diffs, inspect data, and keep agent actions visible."
          />
          <QuickReference
            icon={<ShieldCheck className="size-5" />}
            title="Stay inside safety bounds"
            body="NoMoreIDE avoids broad filesystem scans, destructive Git operations, and killing external processes it did not start."
          />
          <QuickReference
            icon={<Bot className="size-5" />}
            title="Give agents fetchable docs"
            body="Point agents at llms.txt or llms-full.txt when they need stable documentation for NoMoreIDE workflows."
          />
        </section>
      </div>
    </div>
  );
}

function GuidePanel({
  children,
  icon,
  title,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-md border border-border bg-muted/40">
          {icon}
        </div>
        <h3 className="font-semibold">{title}</h3>
      </div>
      <div className="mt-4 grid gap-4 text-sm leading-6 text-muted-foreground">
        {children}
      </div>
    </div>
  );
}

function QuickReference({
  body,
  icon,
  title,
}: {
  body: string;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-md border border-border bg-muted/40">
          {icon}
        </div>
        <h3 className="font-semibold">{title}</h3>
      </div>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{body}</p>
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-5 text-foreground">
      <code>{code}</code>
    </pre>
  );
}
