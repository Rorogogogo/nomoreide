import { cn } from "@/lib/utils";

export function DiffViewer({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="h-full min-h-0 overflow-auto rounded-lg border border-border bg-white p-4 text-xs leading-6">
      {lines.map((line, index) => (
        <span
          className={cn(
            "block min-w-full w-max px-2 font-mono",
            line.startsWith("+") && "bg-emerald-50 text-emerald-800",
            line.startsWith("-") && "bg-red-50 text-red-800",
            line.startsWith("@@") && "bg-muted text-muted-foreground",
          )}
          key={`${index}-${line}`}
        >
          {line || " "}
        </span>
      ))}
    </pre>
  );
}
