import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import yaml from "js-yaml";
import { Alert } from "@/components/ui/alert";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Json = unknown;

function isContainer(value: Json): value is Record<string, Json> | Json[] {
  return value !== null && typeof value === "object";
}

function scalarClass(value: Json): string {
  if (typeof value === "string") return "text-rose-700 dark:text-rose-300";
  if (typeof value === "number") return "text-emerald-700 dark:text-emerald-300";
  if (typeof value === "boolean") return "text-blue-700 dark:text-blue-400";
  if (value === null || value === undefined) return "text-muted-foreground italic";
  return "text-foreground";
}

function scalarText(value: Json): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value === "" ? '""' : value;
  return String(value);
}

function TreeNode({
  label,
  value,
  depth,
}: {
  label: string;
  value: Json;
  depth: number;
}) {
  const [open, setOpen] = useState(true);
  const indent = { paddingLeft: `${depth * 1.1}rem` };

  if (!isContainer(value)) {
    return (
      <div className="flex items-baseline gap-2 py-[1px]" style={indent}>
        <span className="text-muted-foreground">{label}:</span>
        <span className={cn("whitespace-pre-wrap break-words", scalarClass(value))}>
          {scalarText(value)}
        </span>
      </div>
    );
  }

  const entries: [string, Json][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  const summary = Array.isArray(value)
    ? `[${entries.length}]`
    : `{${entries.length}}`;

  return (
    <div>
      <button
        aria-expanded={open}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-1 py-[1px] text-left hover:bg-muted"
        style={indent}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">{summary}</span>
      </button>
      {open
        ? entries.map(([key, child]) => (
            <TreeNode
              key={key}
              label={key}
              value={child}
              depth={depth + 1}
            />
          ))
        : null}
    </div>
  );
}

export function YamlTree({ content }: { content: string }) {
  const t = useT();
  const result = useMemo(() => {
    try {
      const docs = yaml.loadAll(content);
      const value = docs.length <= 1 ? docs[0] : docs;
      return { value, error: null as string | null };
    } catch (caught) {
      return {
        value: null,
        error: caught instanceof Error ? caught.message : String(caught),
      };
    }
  }, [content]);

  if (result.error) {
    return (
      <div className="p-4">
        <Alert variant="destructive">{t("git.yaml.parseError", { error: result.error })}</Alert>
      </div>
    );
  }

  if (!isContainer(result.value)) {
    return (
      <div className="p-4 font-mono text-[12px]">
        <span className={scalarClass(result.value)}>{scalarText(result.value)}</span>
      </div>
    );
  }

  const root: [string, Json][] = Array.isArray(result.value)
    ? result.value.map((item, index) => [String(index), item])
    : Object.entries(result.value);

  return (
    <div className="min-w-max px-4 py-3 font-mono text-[12px] leading-[1.6]">
      {root.map(([key, child]) => (
        <TreeNode key={key} label={key} value={child} depth={0} />
      ))}
    </div>
  );
}
