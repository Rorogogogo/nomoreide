import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ClaudeLogo, CodexLogo, GeminiLogo } from "./agent-logos";
import { useAgentDock } from "./chat/agent-context";

/**
 * The active agent's official mark in its brand color, defaulting to Claude.
 * OpenAI's mark stays monochrome (`text-foreground`) so it adapts to the theme,
 * the way OpenAI intends it to be used.
 */
function ProviderMark({ id, className }: { id?: string; className?: string }) {
  if (id === "codex") return <CodexLogo className={cn("text-foreground", className)} />;
  if (id === "gemini") return <GeminiLogo className={cn("text-[#1A73E8]", className)} />;
  return <ClaudeLogo className={cn("text-[#D97757]", className)} />;
}

/** The active agent's official mark, resolved from context — for AI affordances. */
export function AgentMark({ className }: { className?: string }) {
  const { provider } = useAgentDock();
  return <ProviderMark id={provider?.id} className={className} />;
}

/**
 * The product-wide "ask AI about this object" affordance: one understated,
 * violet-outlined button that fades in on hover (the host row/card must carry
 * `group`). It wears the *active* agent's official logo (Claude / Codex / …),
 * falling back to Claude — so the icon always reflects who will answer.
 */
export function AiSpark({
  onAsk,
  label,
  className,
}: {
  onAsk: () => void;
  label?: string;
  className?: string;
}) {
  const { provider } = useAgentDock();
  const t = useT();
  const title = label ?? t("agent.ask.askProvider", { label: provider?.label ?? "Claude" });
  return (
    <button
      aria-label={title}
      className={cn(
        "flex size-6 items-center justify-center rounded-md opacity-0 transition-all duration-150 hover:bg-muted group-hover:opacity-100",
        className,
      )}
      onClick={onAsk}
      title={title}
      type="button"
    >
      <ProviderMark id={provider?.id} className="size-3.5" />
    </button>
  );
}
