import { FileInput, GitBranch, Plus } from "lucide-react";
import { useT } from "@/lib/i18n";
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
  onImportJetBrains,
}: {
  onOnboardRepo: () => void;
  onOnboardWithAi: () => void;
  onCreateService: () => void;
  onCreateWithAi: () => void;
  onImportJetBrains?: () => void;
}) {
  const t = useT();
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-card/85 p-6">
      <div className="w-full max-w-xl space-y-6">
        <div className="space-y-2 text-center">
          <h2 className="text-xl font-semibold">{t("services.firstRun.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("services.firstRun.desc")}</p>
        </div>

        <div className="space-y-3">
          <GuideStep
            icon={<GitBranch className="size-5" />}
            title={t("services.addFromGithub")}
            description={t("services.firstRun.githubDesc")}
            onClick={onOnboardRepo}
            onAi={onOnboardWithAi}
            aiTitle={t("services.onboardWithAiHint")}
          />
          {onImportJetBrains ? (
            <GuideStep
              icon={<FileInput className="size-5" />}
              title={t("services.jetbrains.menu")}
              description={t("services.jetbrains.firstRunDesc")}
              onClick={onImportJetBrains}
            />
          ) : null}
          <GuideStep
            icon={<Plus className="size-5" />}
            title={t("services.firstRun.createTitle")}
            description={t("services.firstRun.createDesc")}
            onClick={onCreateService}
            onAi={onCreateWithAi}
            aiTitle={t("services.firstRun.createAiHint")}
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
  onAi?: () => void;
  aiTitle?: string;
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
      {onAi ? (
        <button
          className="flex shrink-0 items-center gap-1.5 border-l border-border px-4 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          onClick={onAi}
          title={aiTitle}
          type="button"
        >
          <AgentMark className="size-4 shrink-0" />
          AI
        </button>
      ) : null}
    </div>
  );
}
