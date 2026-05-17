import { ArrowRight, Copy, Sparkles, Terminal } from "lucide-react";

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.57.1.78-.25.78-.55v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.3-5.23-1.28-5.23-5.7 0-1.26.45-2.3 1.2-3.1-.12-.3-.52-1.5.12-3.12 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.5 3.18-1.18 3.18-1.18.64 1.62.24 2.82.12 3.12.75.8 1.2 1.84 1.2 3.1 0 4.43-2.69 5.4-5.25 5.69.41.35.78 1.05.78 2.12v3.14c0 .3.2.66.79.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const INSTALL_CMD = "npm i -g nomoreide";

export function Hero() {
  const [copied, setCopied] = useState(false);

  const copyInstall = async () => {
    await navigator.clipboard.writeText(INSTALL_CMD);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="relative overflow-hidden">
      <BackgroundDecor />

      <div className="relative mx-auto max-w-6xl px-6 pt-24 pb-20 md:pt-32 md:pb-28">
        <div className="flex flex-col items-center text-center">
          <a
            href="https://github.com/Rorogogogo/nomoreide/releases"
            className="group inline-flex items-center gap-2 rounded-full border border-border/80 bg-background/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur transition hover:border-foreground/30 hover:text-foreground"
          >
            <Sparkles className="size-3.5" />
            <span>v0.1.4 — Git review + MCP workflows</span>
            <ArrowRight className="size-3.5 transition group-hover:translate-x-0.5" />
          </a>

          <h1 className="mt-6 max-w-3xl text-balance text-5xl font-semibold tracking-tight md:text-7xl">
            The AI-native{" "}
            <span className="bg-gradient-to-br from-foreground to-foreground/40 bg-clip-text text-transparent">
              terminal workbench
            </span>
          </h1>

          <p className="mt-6 max-w-xl text-pretty text-base text-muted-foreground md:text-lg">
            Run services, review Git diffs, tail logs, and orchestrate MCP
            workflows — all from one terminal-first interface.
          </p>

          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
            <button
              onClick={copyInstall}
              className="group flex items-center gap-3 rounded-md border border-border bg-background/60 px-4 py-2.5 font-mono text-sm shadow-sm backdrop-blur transition hover:border-foreground/30"
              aria-label="Copy install command"
            >
              <span className="text-muted-foreground">$</span>
              <span>{INSTALL_CMD}</span>
              <Copy
                className={cn(
                  "size-3.5 text-muted-foreground transition",
                  copied && "text-green-500",
                )}
              />
              <span
                className={cn(
                  "text-xs text-green-500 transition",
                  copied ? "opacity-100" : "opacity-0",
                )}
              >
                copied
              </span>
            </button>

            <Button asChild size="lg" variant="outline">
              <a
                href="https://github.com/Rorogogogo/nomoreide"
                className="gap-2"
              >
                <GithubIcon className="size-4" />
                Star on GitHub
              </a>
            </Button>
          </div>
        </div>

        <TerminalPreview />
      </div>
    </section>
  );
}

function BackgroundDecor() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,hsl(var(--foreground)/0.08),transparent)]" />
      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground)) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage:
            "radial-gradient(ellipse 60% 60% at 50% 40%, black, transparent)",
        }}
      />
    </div>
  );
}

function TerminalPreview() {
  return (
    <div className="relative mx-auto mt-16 w-full max-w-4xl">
      <div className="absolute -inset-4 -z-10 rounded-3xl bg-gradient-to-br from-foreground/10 via-transparent to-foreground/5 blur-2xl" />
      <div className="overflow-hidden rounded-xl border border-border bg-background/80 shadow-2xl backdrop-blur">
        <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-3">
          <div className="flex gap-1.5">
            <span className="size-3 rounded-full bg-red-500/70" />
            <span className="size-3 rounded-full bg-yellow-500/70" />
            <span className="size-3 rounded-full bg-green-500/70" />
          </div>
          <div className="ml-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Terminal className="size-3.5" />
            <span>nomoreide</span>
          </div>
        </div>
        <pre className="overflow-x-auto p-5 font-mono text-xs leading-relaxed md:text-sm">
          <code>
            <span className="text-muted-foreground">$ </span>
            <span>nomoreide</span>
            {"\n"}
            <span className="text-muted-foreground">
              ▸ services    3 running · 1 stopped
            </span>
            {"\n"}
            <span className="text-muted-foreground">
              ▸ git         feat/hero · 4 files changed
            </span>
            {"\n"}
            <span className="text-muted-foreground">
              ▸ logs        api · 247 lines · live
            </span>
            {"\n"}
            <span className="text-muted-foreground">
              ▸ mcp         2 servers connected
            </span>
            {"\n\n"}
            <span className="text-green-500">✓</span>{" "}
            <span>ready on http://127.0.0.1:4317</span>
          </code>
        </pre>
      </div>
    </div>
  );
}
