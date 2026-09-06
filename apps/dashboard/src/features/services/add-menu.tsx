import { useState } from "react";
import { FileInput, GitBranch, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { AgentMark } from "@/features/agent/ai-spark";

/**
 * The "+" menu: create a service by hand or with the agent, onboard a repo
 * either way, or import from JetBrains.
 *
 * Split from `services-view.tsx`, which owns the list and the dialogs each of
 * these opens. The menu only picks an action and closes.
 */

export function AddMenu({
  onImportJetBrains,
  onCreateService,
  onCreateWithAi,
  onOnboardRepo,
  onOnboardWithAi,
}: {
  onImportJetBrains?: () => void;
  onCreateService: () => void;
  onCreateWithAi: () => void;
  onOnboardRepo: () => void;
  onOnboardWithAi: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  function choose(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div className="relative">
      <Tooltip label={t("services.add")} side="bottom">
        <Button
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={t("services.addService")}
          className="size-7"
          onClick={() => setOpen((current) => !current)}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Plus />
        </Button>
      </Tooltip>
      {open ? (
        <>
          <button
            aria-hidden
            className="fixed inset-0 z-[40] cursor-default"
            onClick={() => setOpen(false)}
            tabIndex={-1}
            type="button"
          />
          <div
            className="absolute right-0 z-[50] mt-1 w-56 overflow-hidden rounded-md border border-border bg-card py-1 shadow-lg"
            role="menu"
          >
            {/* Create Service: the plain form, plus an AI-setup section that
                emerges as a divided "cut" from the right when the row is hovered. */}
            <div className="group flex items-stretch">
              <button
                className="flex flex-1 items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm hover:bg-muted/60 [&_svg]:size-4"
                onClick={() => choose(onCreateService)}
                role="menuitem"
                type="button"
              >
                <Plus />
                {t("services.createService")}
              </button>
              <button
                className="flex max-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap border-l border-transparent px-0 text-[11px] font-medium text-muted-foreground opacity-0 transition-all duration-200 ease-out hover:bg-muted/60 hover:text-foreground group-hover:max-w-24 group-hover:border-border group-hover:px-3 group-hover:opacity-100"
                onClick={() => choose(onCreateWithAi)}
                role="menuitem"
                title={t("services.setupWithAiHint")}
                type="button"
              >
                <AgentMark className="size-3.5 shrink-0" />
                AI
              </button>
            </div>
            {onImportJetBrains ? (
              <button
                className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm hover:bg-muted/60 [&_svg]:size-4"
                onClick={() => choose(onImportJetBrains)}
                role="menuitem"
                type="button"
              >
                <FileInput />
                {t("services.jetbrains.menu")}
              </button>
            ) : null}
            {/* Add from GitHub: the structured wizard, plus an AI cut that hands
                the repo straight to the agent dock (the AI-native path). */}
            <div className="group flex items-stretch">
              <button
                className="flex flex-1 items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm hover:bg-muted/60 [&_svg]:size-4"
                onClick={() => choose(onOnboardRepo)}
                role="menuitem"
                type="button"
              >
                <GitBranch />
                {t("services.addFromGithub")}
              </button>
              <button
                className="flex max-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap border-l border-transparent px-0 text-[11px] font-medium text-muted-foreground opacity-0 transition-all duration-200 ease-out hover:bg-muted/60 hover:text-foreground group-hover:max-w-24 group-hover:border-border group-hover:px-3 group-hover:opacity-100"
                onClick={() => choose(onOnboardWithAi)}
                role="menuitem"
                title={t("services.onboardWithAiHint")}
                type="button"
              >
                <AgentMark className="size-3.5 shrink-0" />
                AI
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
