import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";

export function ArgumentsEditor({
  args,
  onChange,
}: {
  args: string[];
  onChange: (args: string[]) => void;
}) {
  const t = useT();
  const ids = useRef<string[]>([]);
  while (ids.current.length < args.length) ids.current.push(fieldId());
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium">{t("services.form.arguments")}</span>
        <Button
          className="h-6 gap-1 px-2 text-[10px]"
          onClick={() => onChange([...args, ""])}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Plus aria-hidden /> {t("services.form.addArgument")}
        </Button>
      </div>
      {args.length === 0 ? (
        <p className="text-[10px] text-muted-foreground">
          {t("services.form.noArguments")}
        </p>
      ) : (
        <div className="divide-y divide-border/70 border-y border-border/70">
          {args.map((argument, index) => (
            <div className="flex items-center gap-1.5 py-1.5" key={ids.current[index]}>
              <span className="w-5 text-right font-mono text-[9px] text-muted-foreground">
                {index + 1}
              </span>
              <Input
                aria-label={t("services.form.argumentNumber", { number: index + 1 })}
                className="h-7 flex-1 font-mono text-xs"
                onChange={(event) =>
                  onChange(args.map((value, item) => (item === index ? event.target.value : value)))
                }
                value={argument}
              />
              <Button
                aria-label={t("services.form.removeArgument", { number: index + 1 })}
                className="size-7 p-0 text-muted-foreground hover:text-destructive"
                onClick={() => {
                  ids.current.splice(index, 1);
                  onChange(args.filter((_, item) => item !== index));
                }}
                size="icon"
                type="button"
                variant="ghost"
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ServiceEnvEditor({
  entries,
  onChange,
}: {
  entries: Array<{ key: string; value: string }>;
  onChange: (entries: Array<{ key: string; value: string }>) => void;
}) {
  const t = useT();
  const ids = useRef<string[]>([]);
  while (ids.current.length < entries.length) ids.current.push(fieldId());
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[11px] font-medium">{t("services.form.environment")}</div>
          <div className="text-[10px] text-muted-foreground">
            {t("services.form.environmentHint")}
          </div>
        </div>
        <Button
          className="h-6 gap-1 px-2 text-[10px]"
          onClick={() => onChange([...entries, { key: "", value: "" }])}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Plus aria-hidden /> {t("services.form.addVariable")}
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="text-[10px] text-muted-foreground">
          {t("services.form.noEnvironment")}
        </p>
      ) : (
        <div className="divide-y divide-border/70 border-y border-border/70">
          {entries.map((entry, index) => {
            const id = ids.current[index] as string;
            const secret = /secret|token|key|password|passwd|auth|credential/i.test(entry.key);
            const visible = !secret || revealed.has(id);
            return (
              <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] gap-1.5 py-1.5" key={id}>
                <Input
                  aria-label={t("services.form.variableNameNumber", { number: index + 1 })}
                  className="h-7 font-mono text-xs"
                  onChange={(event) =>
                    onChange(entries.map((value, item) =>
                      item === index ? { ...value, key: event.target.value } : value,
                    ))
                  }
                  pattern="[A-Za-z_][A-Za-z0-9_]*"
                  placeholder="NODE_ENV"
                  required
                  value={entry.key}
                />
                <div className="relative">
                  <Input
                    aria-label={t("services.form.variableValueNumber", { number: index + 1 })}
                    className="h-7 pr-8 font-mono text-xs"
                    onChange={(event) =>
                      onChange(entries.map((value, item) =>
                        item === index ? { ...value, value: event.target.value } : value,
                      ))
                    }
                    type={visible ? "text" : "password"}
                    value={entry.value}
                  />
                  {secret ? (
                    <button
                      aria-label={visible ? t("services.env.hide") : t("services.env.reveal")}
                      className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground hover:text-foreground"
                      onClick={() => setRevealed((current) => {
                        const next = new Set(current);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      })}
                      type="button"
                    >
                      {visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                    </button>
                  ) : null}
                </div>
                <Button
                  aria-label={t("services.form.removeVariable", { number: index + 1 })}
                  className="size-7 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    ids.current.splice(index, 1);
                    onChange(entries.filter((_, item) => item !== index));
                  }}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

let nextFieldId = 0;

function fieldId(): string {
  nextFieldId += 1;
  return `service-field-${nextFieldId}`;
}
