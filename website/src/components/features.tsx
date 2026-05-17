import { GitBranch, ScrollText, Server, Workflow } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

type Feature = {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  body: string;
};

const FEATURES: Feature[] = [
  {
    icon: Server,
    title: "Services, orchestrated",
    body: "Start, stop, and watch every local service from one pane. No more juggling ten terminal tabs.",
  },
  {
    icon: GitBranch,
    title: "Git review, in-flow",
    body: "Inspect diffs, navigate hunks, and stage changes without breaking your terminal flow.",
  },
  {
    icon: ScrollText,
    title: "Logs that don't drown you",
    body: "Live-tail with smart filtering. Find the line that matters instead of scrolling forever.",
  },
  {
    icon: Workflow,
    title: "MCP-native workflows",
    body: "First-class MCP server support. Wire up AI tools and let them act inside your workbench.",
  },
];

export function Features() {
  return (
    <section className="relative border-t border-border/60 bg-muted/20">
      <div className="mx-auto max-w-6xl px-6 py-24 md:py-32">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Features
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight md:text-5xl">
            Everything dev needs, none of the noise
          </h2>
          <p className="mt-4 text-muted-foreground md:text-lg">
            nomoreide pulls the tools you already live in into a single
            terminal-native surface — wired for AI from day one.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-2">
          {FEATURES.map((f) => (
            <FeatureCard key={f.title} {...f} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureCard({ icon: Icon, title, body }: Feature) {
  return (
    <div className="group relative bg-background p-8 transition hover:bg-muted/30">
      <div className="flex size-10 items-center justify-center rounded-md border border-border bg-muted/50 text-foreground transition group-hover:border-foreground/30">
        <Icon className="size-5" />
      </div>
      <h3 className="mt-5 text-lg font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
