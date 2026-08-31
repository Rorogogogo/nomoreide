import { Eye, EyeOff, Trash2 } from "lucide-react";
import type { EnvRow } from "./use-service-env";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

/**
 * Editable, but quiet until engaged: a permanent border on every cell turns a
 * short .env file into a wall of boxes. The frame appears on hover and focus,
 * which is when it actually says something.
 */
const CELL =
  "w-full rounded border border-transparent bg-transparent px-1.5 py-0.5 font-mono text-[11px] transition-colors hover:border-border/50 focus:border-border focus:bg-background focus:outline-none";

export function EnvTable({
  rows,
  revealAll,
  onAdd,
  onRemove,
  onUpdate,
}: {
  rows: EnvRow[];
  revealAll: boolean;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, patch: Partial<EnvRow>) => void;
}) {
  const t = useT();
  if (rows.length === 0) {
    return (
      <div className="text-[12px] text-muted-foreground">
        {t("services.env.noVars")}{" "}
        <button className="underline" onClick={onAdd} type="button">
          {t("services.env.addOne")}
        </button>
        .
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-[11px]">
        <thead className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="py-1 pr-3 font-medium">{t("services.env.key")}</th>
            <th className="py-1 pr-3 font-medium">{t("services.env.value")}</th>
            <th className="py-1 w-8" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const masked = !row.reveal && !revealAll;
            return (
              <tr key={index} className="border-t border-border/40">
                <td className="py-0.5 pr-3 align-middle">
                  <input
                    className={CELL}
                    onChange={(event) => onUpdate(index, { key: event.target.value })}
                    placeholder="KEY"
                    spellCheck={false}
                    value={row.key}
                  />
                </td>
                <td className="py-0.5 pr-3 align-middle">
                  <div className="flex items-center gap-0.5">
                    <input
                      className={CELL}
                      onChange={(event) => onUpdate(index, { value: event.target.value })}
                      spellCheck={false}
                      type={masked ? "password" : "text"}
                      value={row.value}
                    />
                    <Button
                      onClick={() => onUpdate(index, { reveal: !row.reveal })}
                      size="icon-sm"
                      title={row.reveal || revealAll ? t("services.env.hide") : t("services.env.reveal")}
                      type="button"
                      variant="ghost"
                    >
                      {row.reveal || revealAll ? <EyeOff /> : <Eye />}
                    </Button>
                  </div>
                </td>
                <td className="py-0.5 align-middle">
                  <Button
                    className="text-muted-foreground hover:text-red-600"
                    onClick={() => onRemove(index)}
                    size="icon-sm"
                    title={t("common.delete")}
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
