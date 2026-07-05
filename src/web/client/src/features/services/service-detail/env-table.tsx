import { Eye, EyeOff, Trash2 } from "lucide-react";
import type { EnvRow } from "./use-service-env";
import { useT } from "@/lib/i18n";

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
      <div className="text-muted-foreground">
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
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1 pr-3">{t("services.env.key")}</th>
            <th className="py-1 pr-3">{t("services.env.value")}</th>
            <th className="py-1 w-8" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const masked = !row.reveal && !revealAll;
            return (
              <tr key={index} className="border-t border-border/40">
                <td className="py-1 pr-3 align-top">
                  <input
                    className="w-full rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono"
                    onChange={(event) => onUpdate(index, { key: event.target.value })}
                    placeholder="KEY"
                    spellCheck={false}
                    value={row.key}
                  />
                </td>
                <td className="py-1 pr-3 align-top">
                  <div className="flex items-center gap-1">
                    <input
                      className="w-full rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono"
                      onChange={(event) => onUpdate(index, { value: event.target.value })}
                      spellCheck={false}
                      type={masked ? "password" : "text"}
                      value={row.value}
                    />
                    <button
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => onUpdate(index, { reveal: !row.reveal })}
                      title={row.reveal || revealAll ? t("services.env.hide") : t("services.env.reveal")}
                      type="button"
                    >
                      {row.reveal || revealAll ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </td>
                <td className="py-1 align-top">
                  <button
                    className="text-muted-foreground hover:text-red-600"
                    onClick={() => onRemove(index)}
                    type="button"
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
