import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TestRunStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useTestRunner } from "./use-test-runner";

const STATUS_VARIANT: Record<TestRunStatus, "secondary" | "success" | "error"> = {
  running: "secondary",
  passed: "success",
  failed: "error",
  error: "error",
};

const STATUS_LABEL: Record<TestRunStatus, string> = {
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  error: "Error",
};

export function TestsTab({ serviceName }: { serviceName: string }) {
  const { run, lines, error, starting, start } = useTestRunner(serviceName);
  const [pattern, setPattern] = useState("");
  const isRunning = run?.status === "running" || starting;
  const showFailure = run?.status === "failed" || run?.status === "error";

  return (
    <div className="space-y-2">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!isRunning) void start(pattern.trim() || undefined);
        }}
      >
        <Input
          className="h-7 flex-1 text-[11px]"
          disabled={isRunning}
          onChange={(event) => setPattern(event.target.value)}
          placeholder="Optional test pattern (e.g. config-store)"
          value={pattern}
        />
        <Button disabled={isRunning} size="sm" type="submit">
          {isRunning ? "Running…" : "Run tests"}
        </Button>
      </form>

      {error ? <div className="text-red-600">{error}</div> : null}

      {run ? (
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <Badge size="small" variant={STATUS_VARIANT[run.status]}>
            {STATUS_LABEL[run.status]}
          </Badge>
          <code className="font-mono text-[11px]">{run.command}</code>
          {run.failingCount > 0 ? <span>· {run.failingCount} failing</span> : null}
          {run.exitCode != null ? <span>· exit {run.exitCode}</span> : null}
        </div>
      ) : (
        <div className="text-muted-foreground">No test runs yet.</div>
      )}

      {lines.length > 0 ? (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono text-[11px]">
          {lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only output log
            <div className={cn(line.stream === "stderr" && "text-red-500")} key={index}>
              {line.text}
            </div>
          ))}
        </pre>
      ) : null}

      {showFailure ? (
        <div className="rounded border border-border bg-muted/40 p-2">
          Failures were piped into the{" "}
          <a className="font-medium underline" href="/errors">
            Error Inbox
          </a>{" "}
          — open an incident there to copy a debugging prompt for your agent.
        </div>
      ) : null}
    </div>
  );
}
