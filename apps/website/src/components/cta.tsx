import { Button } from "./ui/button";

export function CTA() {
  return (
    <section className="relative border-t border-border/60">
      <div className="relative mx-auto max-w-4xl px-6 py-24 text-center md:py-32">
        <div className="absolute inset-x-0 top-0 -z-10 h-full bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,hsl(var(--foreground)/0.08),transparent)]" />
        <h2 className="text-3xl font-semibold tracking-tight md:text-5xl">
          Stop juggling tabs.
          <br />
          <span className="text-muted-foreground">Start shipping.</span>
        </h2>
        <p className="mx-auto mt-5 max-w-lg text-muted-foreground md:text-lg">
          Free and open source. Add it to Claude Code or Codex as an MCP server
          and let your agent use the local tools immediately.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button asChild size="lg">
            <a href="https://github.com/Rorogogogo/nomoreide#connect-your-ai-agent">
              Set up MCP
            </a>
          </Button>
          <Button asChild size="lg" variant="outline">
            <a href="/docs">Read the docs</a>
          </Button>
        </div>
      </div>
    </section>
  );
}
