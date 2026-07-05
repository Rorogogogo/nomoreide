import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TestRunStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/en";
import { useTestRunner } from "./use-test-runner";

const STATUS_VARIANT: Record<TestRunStatus, "secondary" | "success" | "error"> = {
  running: "secondary",
  passed: "success",
  failed: "error",
  error: "error",
};

const STATUS_LABEL: Record<TestRunStatus, TranslationKey> = {
  running: "services.tests.statusRunning",
  passed: "services.tests.statusPassed",
  failed: "services.tests.statusFailed",
  error: "services.tests.statusError",
};

export function TestsTab({ serviceName }: { serviceName: string }) {
  const t = useT();
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
          placeholder={t("services.tests.patternPlaceholder")}
          value={pattern}
        />
        <Button disabled={isRunning} size="sm" type="submit">
          {isRunning ? t("services.tests.running") : t("services.tests.runTests")}
        </Button>
      </form>

      {error ? <div className="text-red-600">{error}</div> : null}

      {run ? (
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <Badge size="small" variant={STATUS_VARIANT[run.status]}>
            {t(STATUS_LABEL[run.status])}
          </Badge>
          <code className="font-mono text-[11px]">{run.command}</code>
          {run.failingCount > 0 ? (
            <span>· {t("services.tests.failing", { count: run.failingCount })}</span>
          ) : null}
          {run.exitCode != null ? (
            <span>· {t("services.tests.exit", { code: run.exitCode })}</span>
          ) : null}
        </div>
      ) : (
        <div className="text-muted-foreground">{t("services.tests.noRuns")}</div>
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
          {t("services.tests.failuresPre")}{" "}
          <a className="font-medium underline" href="/errors">
            {t("services.tests.errorInbox")}
          </a>{" "}
          {t("services.tests.failuresPost")}
        </div>
      ) : null}
    </div>
  );
}
