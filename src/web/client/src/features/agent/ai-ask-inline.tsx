import { useCallback, useState } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AiSpark } from "./ai-spark";

/**
 * Compact inline "tell the agent what to do" field — the shape used by the Tools
 * cards' Add inputs and the commit row's ask affordance. The user types one line
 * and submits; the host wraps it into a full prompt and sends it straight to the
 * dock (no extra step). Enter/check submits, Esc/cross cancels.
 */
export function AiAskInline({
  placeholder,
  onSubmit,
  onCancel,
  className,
}: {
  placeholder: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
  };
  // Focus on mount via callback ref: the field only renders after an explicit
  // "ask" action, so moving focus into it is the expected behavior.
  const focusOnMount = useCallback((node: HTMLInputElement | null) => {
    node?.focus();
  }, []);
  return (
    <form
      className={cn(
        "flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/5 px-1.5 py-1",
        className,
      )}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <AiSpark className="size-5 opacity-100" label="Send to the agent" onAsk={submit} />
      <input
        ref={focusOnMount}
        className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
        placeholder={placeholder}
        value={value}
      />
      <Button type="submit" size="icon" className="size-6" disabled={!value.trim()} title="Send">
        <Check className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6"
        onClick={onCancel}
        aria-label="Cancel"
        title="Cancel"
      >
        <X className="size-3.5" />
      </Button>
    </form>
  );
}
