import { GitBranch, Plus } from "lucide-react";
import { AgentMark } from "../agent/ai-spark";

/**
 * Full-area first-run state shown when no services are registered yet. Instead
 * of a blank dashboard, it takes over the whole pane and presents the existing
 * add paths (GitHub onboard / manual form) as big primary choices, each with an
 * AI cut that hands the same job to the agent dock.
 */
export function FirstRunGuide({
  onOnboardRepo,
  onOnboardWithAi,
  onCreateService,
  onCreateWithAi,
}: {
  onOnboardRepo: () => void;
  onOnboardWithAi: () => void;
  onCreateService: () => void;
  onCreateWithAi: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-card/85 p-6">
      <div className="w-full max-w-xl space-y-6">
        <div className="space-y-2 text-center">
          <h2 className="text-xl font-semibold">Set up your first service</h2>
          <p className="text-sm text-muted-foreground">
            NoMoreIDE runs and watches your services so you don't have to babysit
            terminals. Add your first one to get started — or let the agent do it
            for you.
          </p>
        </div>

        <div className="space-y-3">
          <GuideStep
            icon={<GitBranch className="size-5" />}
            title="Add from GitHub"
            description="Point at a repo — we detect how to run it and register it for you."
            onClick={onOnboardRepo}
            onAi={onOnboardWithAi}
            aiTitle="Onboard with AI — the agent clones, detects and runs it for you"
          />
          <GuideStep
            icon={<Plus className="size-5" />}
            title="Create a service"
            description="Define the command, working directory and port yourself."
            onClick={onCreateService}
            onAi={onCreateWithAi}
            aiTitle="Set up with AI — the agent walks you through it, one step at a time"
          />
        </div>
      </div>
    </div>
  );
}

function GuideStep({
  icon,
  title,
  description,
  onClick,
  onAi,
  aiTitle,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  onAi: () => void;
  aiTitle: string;
}) {
  return (
    <div className="group flex items-stretch overflow-hidden rounded-lg border border-border bg-card shadow-sm transition-colors hover:border-foreground/20">
      <button
        className="flex flex-1 items-start gap-3 px-4 py-4 text-left hover:bg-muted/60"
        onClick={onClick}
        type="button"
      >
        <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
        <span className="min-w-0 space-y-1">
          <span className="block text-sm font-semibold">{title}</span>
          <span className="block text-xs text-muted-foreground">{description}</span>
        </span>
      </button>
      <button
        className="flex shrink-0 items-center gap-1.5 border-l border-border px-4 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        onClick={onAi}
        title={aiTitle}
        type="button"
      >
        <AgentMark className="size-4 shrink-0" />
        AI
      </button>
    </div>
  );
}
