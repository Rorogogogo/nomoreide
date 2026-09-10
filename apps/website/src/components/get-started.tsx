import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, Download as DownloadIcon, ShieldAlert } from "lucide-react";
import {
  findLatestMacosRelease,
  RELEASES_URL,
  type MacosRelease,
} from "../lib/latest-macos-release";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

/**
 * Get started: install, then connect an agent.
 *
 * **Two steps in order, not two competing sections.** The page used to present
 * an "MCP setup" block and an "Install" block, and `install.sh` was the first
 * option in *both* — so the same command read as two different products, and a
 * reader who ran it from one block had no way to tell whether the other still
 * applied. Installing and registering an agent are one sequence: you cannot
 * `nomoreide setup claude` before there is a `nomoreide`.
 *
 * **One command visible at a time.** Every install route was previously
 * rendered at once, three stacked cards deep, which asks the reader to
 * comparison-shop a decision that barely matters — they all deliver the same
 * binary. Tabs make the recommended route the default and the rest one click
 * away, which is the shape Codex's own getting-started page uses.
 */

type Choice = {
  id: string;
  label: string;
  description: string;
  /** Rendered `$`-prefixed when shell; a prompt wraps instead of scrolling. */
  language: "shell" | "prompt";
  lines: string[];
  /** What the copy button puts on the clipboard — usually just the command. */
  copyText: string;
};

const INSTALLS: Choice[] = [
  {
    id: "script",
    label: "macOS / Linux",
    description:
      "Downloads a prebuilt binary, verifies its checksum, and registers it with every agent it finds. No Node, no Rust toolchain.",
    language: "shell",
    lines: ["curl -fsSL https://www.nomoreide.com/install.sh | sh"],
    copyText: "curl -fsSL https://www.nomoreide.com/install.sh | sh",
  },
  {
    id: "npm",
    label: "npm",
    description:
      "Ships the same prebuilt binary — npm is only the delivery mechanism, and nothing it installs runs on Node.",
    language: "shell",
    lines: ["npm install -g nomoreide"],
    copyText: "npm install -g nomoreide",
  },
  {
    id: "cargo",
    label: "cargo",
    description: "Builds from source from crates.io. Takes a few minutes.",
    language: "shell",
    lines: ["cargo install nomoreide"],
    copyText: "cargo install nomoreide",
  },
];

const AGENTS: Choice[] = [
  {
    id: "all",
    label: "Every agent",
    description:
      "The install script already did this. Run it again after installing a new agent — it writes each one's own config, in its own format.",
    language: "shell",
    lines: ["nomoreide setup claude codex gemini cursor windsurf"],
    copyText: "nomoreide setup claude codex gemini cursor windsurf",
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
    id: "other",
    label: "Gemini · Cursor · Windsurf",
    description:
      "Same command, one word different. Each writes that agent's own config and records the absolute path of the installed binary.",
    language: "shell",
    lines: ["nomoreide setup gemini", "nomoreide setup cursor", "nomoreide setup windsurf"],
    copyText: "nomoreide setup gemini",
  },
];

const OPEN_STEPS = [
  "Drag NoMoreIDE into your Applications folder and double-click it — macOS will say it can't be verified.",
  "Open System Settings → Privacy & Security.",
  'Scroll down to the Security section. You\'ll see "NoMoreIDE was blocked to protect your Mac" — click Open Anyway.',
  "Confirm once more with Touch ID or your password. After that it launches like any other app.",
];

export function GetStarted() {
  const [release, setRelease] = useState<MacosRelease | null>(null);

  useEffect(() => {
    let active = true;
    void findLatestMacosRelease()
      .then((latest) => {
        if (active) setRelease(latest);
      })
      .catch(() => {
        // Keep the releases-page fallback when GitHub is unavailable or
        // rate-limits an unauthenticated browser request.
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="relative border-t border-border/60" id="download">
      <div className="relative mx-auto max-w-3xl px-6 py-24 md:py-28">
        <div className="absolute inset-x-0 top-0 -z-10 h-full bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,hsl(var(--foreground)/0.06),transparent)]" />

        <div className="text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Get started
          </p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight md:text-5xl">
            One binary. No Node required.
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-muted-foreground md:text-lg">
            The CLI, the TUI, the web dashboard and the MCP server are the same
            Rust executable, with the dashboard compiled in. Install it, then
            point your agent at it.
          </p>
        </div>

        <Step
          index={1}
          title="Install NoMoreIDE"
          /* The vertical rule is what makes two steps read as a sequence
             rather than as two more sections to choose between. */
          rule
        >
          <Tabs choices={INSTALLS} />
          <p className="mt-4 text-xs text-muted-foreground">
            Prefer an archive? Every release publishes macOS (Apple silicon and
            Intel) and Linux (x86_64 and arm64) builds with a single{" "}
            <code className="font-mono">SHA256SUMS</code>, on the{" "}
            <a className="underline hover:text-foreground" href={RELEASES_URL}>
              releases page
            </a>
            .
          </p>
        </Step>

        <Step index={2} title="Connect your coding agent" rule>
          <Tabs choices={AGENTS} />
          <p className="mt-4 text-xs text-muted-foreground">
            Then open the dashboard at{" "}
            <code className="font-mono text-foreground">http://127.0.0.1:4317/</code> — it
            starts on demand, and every front door shares one daemon.
          </p>
        </Step>

        <Step index={3} title="Or run it as a desktop app">
          <p className="text-sm leading-6 text-muted-foreground">
            The same workbench packaged natively with Tauri — no terminal. It
            keeps its own runtime, so services you start in the app are separate
            from the CLI's.
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <Button asChild>
              <a className="gap-2" href={release?.downloadUrl ?? RELEASES_URL}>
                <DownloadIcon className="size-4" />
                {release?.version
                  ? `Download v${release.version} for macOS`
                  : "Download for macOS"}
              </a>
            </Button>
            <Button asChild variant="outline">
              <a href="https://github.com/Rorogogogo/nomoreide">View source on GitHub</a>
            </Button>
          </div>

          <details className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
            {/* Collapsed by default: it is a one-time hurdle for the readers who
                choose the app, and as an always-open amber panel it was the
                loudest thing in a section about getting started. */}
            <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
              <ShieldAlert className="size-4 shrink-0 text-amber-500" />
              First launch: macOS will block it (and that's expected)
            </summary>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              This is a free, open-source side project and I haven't paid for an
              Apple Developer account ($99/year), so the app isn't notarized.
              macOS plays it safe and blocks unsigned apps on first open. Here's
              the one-time fix:
            </p>
            <ol className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
              {OPEN_STEPS.map((step, index) => (
                <li className="flex gap-3" key={step}>
                  <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-xs font-medium text-foreground">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </details>
        </Step>
      </div>
    </section>
  );
}

/** A numbered step, with the connecting rule the sequence is read by. */
function Step({
  children,
  index,
  rule,
  title,
}: {
  children: ReactNode;
  index: number;
  rule?: boolean;
  title: string;
}) {
  return (
    <div className="relative mt-12 flex gap-4 md:gap-6">
      <div className="flex flex-col items-center">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-background text-sm font-medium">
          {index}
        </span>
        {rule ? <span aria-hidden="true" className="mt-2 w-px flex-1 bg-border" /> : null}
      </div>
      <div className="min-w-0 flex-1 pb-2">
        <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

/** One command at a time, chosen by a tab strip. */
function Tabs({ choices }: { choices: Choice[] }) {
  const [active, setActive] = useState(choices[0].id);
  const [copied, setCopied] = useState(false);
  const choice = choices.find((entry) => entry.id === active) ?? choices[0];

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <>
      <div className="flex flex-wrap gap-1 rounded-md bg-muted/50 p-1" role="tablist">
        {choices.map((entry) => (
          <button
            aria-selected={entry.id === choice.id}
            className={cn(
              "rounded px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground",
              entry.id === choice.id && "bg-background text-foreground shadow-sm",
            )}
            key={entry.id}
            onClick={() => {
              setActive(entry.id);
              setCopied(false);
            }}
            role="tab"
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </div>

      <p className="mt-3 text-sm leading-6 text-muted-foreground">{choice.description}</p>

      <div className="relative mt-3" role="tabpanel">
        <pre
          className={cn(
            "overflow-x-auto rounded-md border border-border bg-background py-3 pl-4 pr-12 font-mono text-xs leading-relaxed",
            choice.language === "prompt" && "whitespace-pre-wrap",
          )}
        >
          <code>
            {choice.lines.map((line, index) => (
              <span className="block" key={`${choice.id}-${index}`}>
                {choice.language === "shell" && line !== "" && !line.startsWith("#") ? (
                  <span className="select-none text-muted-foreground">$ </span>
                ) : null}
                {line === "" ? " " : line}
              </span>
            ))}
          </code>
        </pre>
        <button
          aria-label={`Copy ${choice.label} command`}
          className="absolute right-2 top-2 rounded-md border border-transparent p-1.5 text-muted-foreground transition hover:border-border hover:text-foreground"
          onClick={() => {
            void navigator.clipboard.writeText(choice.copyText).then(() => setCopied(true));
          }}
          type="button"
        >
          {copied ? (
            <Check className="size-3.5 text-green-500" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </button>
      </div>
    </>
  );
}
