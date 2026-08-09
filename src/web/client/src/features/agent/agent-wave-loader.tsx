import { cn } from "@/lib/utils";
import {
  ClaudeCodeBotLogo,
  CodexLogo,
  DeepSeekLogo,
  GeminiLogo,
  KimiLogo,
} from "./agent-logos";

const MARKS = [
  { id: "claude-code", Mark: ClaudeCodeBotLogo },
  { id: "codex", Mark: CodexLogo },
  { id: "gemini", Mark: GeminiLogo },
  { id: "deepseek", Mark: DeepSeekLogo },
  { id: "kimi", Mark: KimiLogo },
] as const;

export function AgentWaveLoader({
  label = "AI is working…",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      aria-label={label}
      className={cn(
        "inline-flex flex-col items-center gap-0.5 text-[11px] text-muted-foreground",
        className,
      )}
      role="status"
    >
      <span aria-hidden className="relative flex h-7 items-end gap-2">
        <span className="agent-wave-signal motion-reduce:hidden" />
        {MARKS.map(({ id, Mark }, index) => (
          <span
            className="agent-wave-mark grid size-5 place-items-center motion-reduce:animate-none motion-reduce:opacity-70"
            key={id}
            style={{ animationDelay: `${index * 176}ms` }}
          >
            <Mark className="size-4" />
          </span>
        ))}
      </span>
      <span>{label}</span>
    </div>
  );
}
