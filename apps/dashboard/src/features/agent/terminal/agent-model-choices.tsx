import { useState } from "react";
import { Check } from "lucide-react";
import type { AgentChatProviderInfo } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { agentModelOptions } from "./agent-model-options";

/**
 * The model list itself — "CLI default", the suggested models, and a free-text
 * field. Shared by the new-session menu and the toolbar chip so the two ways of
 * changing a model cannot offer different choices.
 */
export function AgentModelChoices({
  onSelect,
  pinned,
  provider,
}: {
  onSelect: (model: string | null) => void;
  pinned: string | undefined;
  provider: AgentChatProviderInfo["id"];
}) {
  const t = useT();
  const [customModel, setCustomModel] = useState("");
  const options = agentModelOptions(provider);

  return (
    <>
      <button
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[11px] hover:bg-muted"
        onClick={() => onSelect(null)}
        role="menuitem"
        type="button"
      >
        <Check
          className={cn("size-3 shrink-0", pinned ? "invisible" : "text-primary")}
        />
        <span className="min-w-0 flex-1 truncate">{t("dock.modelDefault")}</span>
      </button>
      {options.map((option) => (
        <button
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[11px] hover:bg-muted"
          key={option.id}
          onClick={() => onSelect(option.id)}
          role="menuitem"
          type="button"
        >
          <Check
            className={cn(
              "size-3 shrink-0",
              pinned === option.id ? "text-primary" : "invisible",
            )}
          />
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
            {option.id}
          </span>
        </button>
      ))}
      {/*
        The catalogue above is a convenience list, not a contract — provider
        line-ups move faster than releases, so any model id can be typed
        straight through and is validated only for argv safety server-side.
      */}
      <form
        className="mt-1 flex items-center gap-1 px-2 pb-1"
        onSubmit={(event) => {
          event.preventDefault();
          const value = customModel.trim();
          if (!value) return;
          setCustomModel("");
          onSelect(value);
        }}
      >
        <input
          aria-label={t("dock.modelCustom")}
          className="min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 py-1 font-mono text-[10px] outline-none placeholder:text-muted-foreground focus:border-primary/50"
          maxLength={64}
          onChange={(event) => setCustomModel(event.currentTarget.value)}
          placeholder={t("dock.modelCustomPlaceholder")}
          value={customModel}
        />
        <button
          className="shrink-0 rounded-sm px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          disabled={!customModel.trim()}
          type="submit"
        >
          {t("dock.modelPin")}
        </button>
      </form>
    </>
  );
}
