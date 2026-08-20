import {
  Bot,
  Database,
  GitBranch,
  GitPullRequestArrow,
  PanelsTopLeft,
  ScrollText,
  Server,
  Workflow,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";

type Feature = {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  body: string;
};

const FEATURES: Feature[] = [
  {
    icon: Server,
    title: "Run your development services",
    body: "Start, stop, and restart your frontend, backend, database, workers, or any custom service bundle.",
  },
  {
    icon: ScrollText,
    title: "See what your project is doing",
    body: "Watch logs, terminal output, and port conflicts in real time without switching between tools.",
  },
  {
    icon: GitBranch,
    title: "Manage Git safely",
    body: "Review status, diffs, branches, staged files, and commits so your AI agent understands the current code changes.",
  },
  {
    icon: Database,
    title: "Connect database work",
    body: "Bring database inspection and operations into the same AI-native development workflow.",
  },
  {
    icon: GitPullRequestArrow,
    title: "Integrate GitHub workflows",
    body: "Bring GitHub Actions and repo workflows into local development so you can trigger and inspect them from one place.",
  },
  {
    icon: Workflow,
    title: "Assemble workflows like building blocks",
    body: "Combine terminal, Git, databases, logs, services, and GitHub into reusable workflows triggered by a click or a prompt.",
  },
  {
    icon: Bot,
    title: "Manage your agents' environments",
    body: "See every coding agent's MCP servers and skills side by side, move them between agents with a preview, and share whole setups as profiles through the registry.",
  },
  {
    icon: PanelsTopLeft,
    title: "CLI + Web UI entry points",
    body: "Use the CLI when you want speed, or open the Web UI when visualization helps. No heavy IDE required.",
  },
];

export function Features() {
  return (
    <section className="relative border-t border-border/60 bg-muted/20">
      <div className="mx-auto max-w-6xl px-6 py-24 md:py-32">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Capabilities
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight md:text-5xl">
            What can NoMoreIDE do?
          </h2>
          <p className="mt-4 text-muted-foreground md:text-lg">
            NoMoreIDE pulls the tools you already live in into a single
            AI-native surface for local development.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-2 lg:grid-cols-3">
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
