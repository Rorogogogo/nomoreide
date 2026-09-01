import { useEffect, useState } from "react";
import { ArrowRight, Copy, Download, Sparkles, Star } from "lucide-react";
import { App as WorkbenchApp } from "@nomoreide/dashboard/app";
import { installWebsiteMockApi } from "../mock-api";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

installWebsiteHistoryGuard();
installWebsiteMockApi();

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.57.1.78-.25.78-.55v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.3-5.23-1.28-5.23-5.7 0-1.26.45-2.3 1.2-3.1-.12-.3-.52-1.5.12-3.12 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.5 3.18-1.18 3.18-1.18.64 1.62.24 2.82.12 3.12.75.8 1.2 1.84 1.2 3.1 0 4.43-2.69 5.4-5.25 5.69.41.35.78 1.05.78 2.12v3.14c0 .3.2.66.79.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

const PROMPT_LINES = [
  "Set up NoMoreIDE for me — an AI-native local dev workbench exposed as an MCP server.",
  "",
  "1. Install it: `curl -fsSL https://www.nomoreide.com/install.sh | sh`. That installs the",
  "   `nomoreide` binary and registers it with every AI agent on this machine.",
  "2. If you were already registered, restart yourself, then confirm the `nomoreide` tools are connected.",
  "3. Open the NoMoreIDE Web UI at http://127.0.0.1:4317/ and list my current services so I can start working.",
];

// One command per agent, because `nomoreide setup` writes each agent's own
// config in its own format — and records the *absolute* path of the installed
// binary, which is what an agent launched from a desktop session (with no
// shell PATH) needs. The manual `mcp add` line is kept alongside for anyone
// who would rather see exactly what is written.
const AGENT_SETUPS = [
  {
    id: "install",
    label: "Everything at once",
    description:
      "Installs the binary and registers it with every agent it finds — Claude Code, Codex, Gemini, Cursor and Windsurf.",
    language: "shell",
    lines: ["curl -fsSL https://www.nomoreide.com/install.sh | sh"],
    copyText: "curl -fsSL https://www.nomoreide.com/install.sh | sh",
  },
  {
    id: "prompt",
    label: "Any agent (prompt)",
    description:
      "Paste this into any AI coding agent — it installs, verifies, and opens NoMoreIDE for you.",
    language: "prompt",
    lines: PROMPT_LINES,
    copyText: PROMPT_LINES.join("\n"),
  },
  {
    id: "claude",
    label: "Claude Code",
    description: "Registers the MCP server and installs the debugging skill.",
    language: "shell",
    lines: [
      "nomoreide setup claude",
      "",
      "# or register it by hand:",
      "claude mcp add --transport stdio nomoreide -- nomoreide mcp",
    ],
    copyText: "nomoreide setup claude",
  },
  {
    id: "codex",
    label: "Codex CLI",
    description: "Registers the MCP server and installs the debugging skill.",
    language: "shell",
    lines: [
      "nomoreide setup codex",
      "",
      "# or register it by hand:",
      "codex mcp add nomoreide -- nomoreide mcp",
    ],
    copyText: "nomoreide setup codex",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    description: "Registers the MCP server and installs the debugging skill.",
    language: "shell",
    lines: [
      "nomoreide setup gemini",
      "",
      "# writes ~/.gemini/settings.json for you",
    ],
    copyText: "nomoreide setup gemini",
  },
  {
    id: "cursor",
    label: "Cursor",
    description: "Writes ~/.cursor/mcp.json and installs the debugging skill.",
    language: "shell",
    lines: ["nomoreide setup cursor"],
    copyText: "nomoreide setup cursor",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    description:
      "Writes ~/.codeium/windsurf/mcp_config.json and installs the debugging skill.",
    language: "shell",
    lines: ["nomoreide setup windsurf"],
    copyText: "nomoreide setup windsurf",
  },
];

const GITHUB_REPO_API = "https://api.github.com/repos/Rorogogogo/nomoreide";

function formatStarCount(stars: number) {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: stars >= 1000 ? 1 : 0,
    notation: stars >= 1000 ? "compact" : "standard",
  }).format(stars);
}

export function Hero() {
  const [selectedAgentId, setSelectedAgentId] = useState(AGENT_SETUPS[0].id);
  const [copied, setCopied] = useState(false);
  const [githubStars, setGithubStars] = useState<number | null>(null);
  const selectedAgent =
    AGENT_SETUPS.find((agent) => agent.id === selectedAgentId) ?? AGENT_SETUPS[0];

  useEffect(() => {
    const controller = new AbortController();

    async function loadGithubStars() {
      try {
        const response = await fetch(GITHUB_REPO_API, {
          headers: { Accept: "application/vnd.github+json" },
          signal: controller.signal,
        });
        if (!response.ok) return;

        const data = (await response.json()) as { stargazers_count?: unknown };
        if (typeof data.stargazers_count === "number") {
          setGithubStars(data.stargazers_count);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }

    void loadGithubStars();
    return () => controller.abort();
  }, []);

  const copyInstall = async () => {
    await navigator.clipboard.writeText(selectedAgent.copyText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const selectAgent = (id: string) => {
    setSelectedAgentId(id);
    setCopied(false);
  };

  return (
    <section className="relative overflow-hidden">
      <BackgroundDecor />

      <div className="relative mx-auto max-w-7xl px-4 pt-8 pb-10 sm:px-6 md:pt-10 md:pb-12">
        <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
          <a
            className="group inline-flex items-center gap-2 rounded-full border border-border/80 bg-background/70 px-3 py-1 text-xs text-muted-foreground backdrop-blur transition hover:border-foreground/30 hover:text-foreground"
            href="https://github.com/Rorogogogo/nomoreide/releases"
          >
            <Sparkles className="size-3.5" />
            <span>AI-native local workbench for agentic coding</span>
            <ArrowRight className="size-3.5 transition group-hover:translate-x-0.5" />
          </a>

          <h1 className="mt-4 max-w-5xl text-balance text-4xl font-semibold tracking-tight md:text-6xl">
            <span className="block">Use NoMoreIDE.</span>
            <span className="block">You need no more IDE.</span>
          </h1>

          <p className="mt-4 max-w-2xl text-pretty text-base leading-7 text-muted-foreground md:text-lg">
            Built for{" "}
            <span className="font-semibold text-foreground underline decoration-foreground/25 decoration-4 underline-offset-4">
              vibe coders
            </span>
            : one local workbench where your AI agent can run services, read
            logs, review diffs, inspect data, and keep you in control.
          </p>

          <div className="mt-6 flex flex-col items-center gap-3">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Two ways to run it
            </p>
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
              <Button asChild size="lg">
                <a className="gap-2" href="#download">
                  <Download className="size-4" />
                  Download for macOS
                </a>
              </Button>
              <span className="text-sm text-muted-foreground">or</span>
              <Button asChild size="lg" variant="outline">
                <a href="#mcp-setup">Add to your AI agent (MCP)</a>
              </Button>
            </div>
            <p className="max-w-md text-sm text-muted-foreground">
              Grab the native Mac app, or wire NoMoreIDE into Claude Code, Codex,
              or any agent as an MCP server. Same workbench either way.
            </p>

            <div className="mt-1 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm">
              <a
                className="text-muted-foreground transition hover:text-foreground"
                href="#hero-demo"
              >
                Try the live mock
              </a>
              <a
                className="text-muted-foreground transition hover:text-foreground"
                href="/docs"
              >
                Read the docs
              </a>
              <a
                className="inline-flex items-center gap-1.5 text-muted-foreground transition hover:text-foreground"
                href="https://github.com/Rorogogogo/nomoreide"
              >
                <GithubIcon className="size-4" />
                <span>GitHub</span>
                {githubStars === null ? null : (
                  <span
                    aria-label={`${githubStars} GitHub stars`}
                    className="inline-flex items-center gap-1"
                  >
                    <Star className="size-3.5 fill-current" />
                    {formatStarCount(githubStars)}
                  </span>
                )}
              </a>
            </div>
          </div>
        </div>

        <div
          className="website-real-demo relative mt-7 h-[560px] overflow-hidden rounded-lg border border-border bg-background shadow-2xl md:h-[680px]"
          id="hero-demo"
        >
          <div className="website-real-demo-canvas">
            <WorkbenchApp syncLocation={false} />
          </div>
        </div>

        <div
          className="mx-auto mt-8 max-w-4xl rounded-lg border border-border bg-background/75 p-3 shadow-sm backdrop-blur"
          id="mcp-setup"
        >
          <div className="flex flex-col gap-2 px-2 py-2 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                MCP setup
              </p>
              <h2 className="mt-1 text-xl font-semibold tracking-tight">
                Add NoMoreIDE to your coding agent.
              </h2>
            </div>
            <p className="max-w-lg text-sm leading-6 text-muted-foreground">
              One command installs NoMoreIDE and wires it into every agent on
              your machine — or pick your agent below. No Node.js required. The
              Web UI runs locally at{" "}
              <code className="font-mono text-foreground">
                http://127.0.0.1:4317/
              </code>
              .
            </p>
          </div>

          <div
            aria-label="MCP setup agent"
            className="mt-3 grid grid-cols-2 gap-1 rounded-md bg-muted/50 p-1 sm:grid-cols-4"
            role="tablist"
          >
            {AGENT_SETUPS.map((agent) => (
              <button
                aria-selected={agent.id === selectedAgent.id}
                className={cn(
                  "rounded px-3 py-2 text-center text-xs font-medium text-muted-foreground transition hover:text-foreground",
                  agent.id === selectedAgent.id && "bg-background text-foreground shadow-sm",
                )}
                key={agent.id}
                onClick={() => selectAgent(agent.id)}
                role="tab"
                type="button"
              >
                {agent.label}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 px-2 pt-4 pb-2">
            <p className="text-sm text-muted-foreground">{selectedAgent.description}</p>
            <button
              aria-label={`Copy ${selectedAgent.label} MCP setup`}
              className="inline-flex shrink-0 items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
              onClick={copyInstall}
              type="button"
            >
              <Copy className={cn("size-3.5 transition", copied && "text-green-500")} />
              <span className={cn(copied && "text-green-500")}>
                {copied ? "Copied" : "Copy"}
              </span>
            </button>
          </div>

          <pre
            className={cn(
              "overflow-x-auto rounded-md border border-border bg-background px-4 py-3 font-mono text-xs leading-relaxed shadow-inner sm:text-sm",
              selectedAgent.language === "prompt" && "whitespace-pre-wrap",
            )}
            role="tabpanel"
          >
            <code>
              {selectedAgent.lines.map((line, index) => (
                <span className="block" key={`${selectedAgent.id}-${index}`}>
                  {selectedAgent.language === "shell" ? (
                    <span className="text-muted-foreground">$ </span>
                  ) : null}
                  {line === "" ? " " : line}
                </span>
              ))}
            </code>
          </pre>
        </div>
      </div>
    </section>
  );
}

function BackgroundDecor() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_42%_at_50%_0%,hsl(var(--foreground)/0.09),transparent)]" />
      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground)) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage:
            "radial-gradient(ellipse 64% 64% at 50% 30%, black, transparent)",
        }}
      />
    </div>
  );
}

function installWebsiteHistoryGuard() {
  if (typeof window === "undefined") return;
  const currentWindow = window as Window & {
    __nomoreideWebsiteHistoryGuard?: boolean;
  };
  if (currentWindow.__nomoreideWebsiteHistoryGuard) return;
  currentWindow.__nomoreideWebsiteHistoryGuard = true;

  const appRoutes = new Set(["/", "/git", "/agent", "/errors", "/database", "/terminal"]);
  const originalPushState = window.history.pushState.bind(window.history);
  const originalReplaceState = window.history.replaceState.bind(window.history);

  function isEmbeddedAppRoute(url?: string | URL | null) {
    if (url === undefined || url === null) return false;
    const nextUrl = new URL(String(url), window.location.href);
    return nextUrl.origin === window.location.origin && appRoutes.has(nextUrl.pathname);
  }

  window.history.pushState = (data, unused, url) => {
    if (isEmbeddedAppRoute(url)) return;
    return originalPushState(data, unused, url);
  };

  window.history.replaceState = (data, unused, url) => {
    if (isEmbeddedAppRoute(url)) return;
    return originalReplaceState(data, unused, url);
  };
}
