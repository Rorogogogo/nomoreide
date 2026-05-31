import { useState } from "react";
import { Check, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AiSpark } from "../ai-spark";

/** The Tools cards' "paste a URL / command" field is the shared inline ask input. */
export { AiAskInline as AddInline } from "../ai-ask-inline";

/** Header "Add" button shared by every Tools card; toggles the inline input. */
export function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 gap-1 px-1.5 text-[11px] font-medium"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <Plus className="size-3.5" />
      Add
    </Button>
  );
}

/**
 * Per-row AI affordances: the violet "ask AI" spark plus a delete control. Both
 * fade in on hover (the host row must carry `group`). Delete is AI-native — it
 * hands a removal prompt to the agent rather than mutating config directly — and
 * clicking the bin swaps in a check/cross confirm pair first.
 */
export function RowActions({
  askLabel,
  removeLabel,
  onAsk,
  onRemove,
}: {
  askLabel: string;
  removeLabel: string;
  onAsk: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <AiSpark label={askLabel} onAsk={onAsk} />
      <DeleteConfirm label={removeLabel} onConfirm={onRemove} />
    </div>
  );
}

/** Bin button that expands into a confirm (check) / cancel (cross) pair. */
function DeleteConfirm({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <span className="flex items-center gap-0.5">
        <button
          type="button"
          aria-label={label}
          title={label}
          onClick={() => {
            setConfirming(false);
            onConfirm();
          }}
          className="flex size-6 items-center justify-center rounded-md text-emerald-600 transition-colors hover:bg-emerald-500/10"
        >
          <Check className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Cancel"
          title="Cancel"
          onClick={() => setConfirming(false)}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
        >
          <X className="size-3.5" />
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setConfirming(true)}
      className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all duration-150 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
    >
      <Trash2 className="size-3.5" />
    </button>
  );
}
