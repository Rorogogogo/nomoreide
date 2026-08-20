import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

/** The Tools cards' "paste a URL / command" field is the shared inline ask input. */
export { AiAskInline as AddInline } from "../ai-ask-inline";

/** Header "Add" button shared by every Tools card; toggles the inline input. */
export function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  const t = useT();
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
      {t("common.add")}
    </Button>
  );
}
