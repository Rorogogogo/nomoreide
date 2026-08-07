import { useEffect, useState } from "react";
import {
  getVercelRuntimeLogs,
  type VercelBuildLogLine,
  type VercelRuntimeLogLine,
} from "@/lib/api";
import { Loading } from "@/components/ui/loading";
import { TabStrip } from "@/components/ui/tab-strip";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type LogTab = "build" | "runtime";

/**
 * A deployment's two log streams, which answer two different questions: the
 * build log says why it didn't ship, the runtime log says why the shipped thing
 * is failing requests.
 *
 * Build logs are fetched by the parent (it already polls them while a build
 * runs); runtime logs are fetched here, lazily, because they are only worth a
 * request once the user asks for the tab — and on plans that do not serve them
 * the answer is an empty list, not an error.
 */
export function DeploymentLogs({
  buildLogs,
  loading,
  uid,
}: {
  buildLogs: VercelBuildLogLine[];
  loading: boolean;
  uid: string;
}) {
  const t = useT();
  const [tab, setTab] = useState<LogTab>("build");

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-muted/10">
      <div className="shrink-0 border-b border-border px-3 py-1.5">
        <TabStrip<LogTab>
          ariaLabel={t("vercel.logs.tabsLabel")}
          idPrefix="vercel-logs"
          onSelect={setTab}
          tabs={[
            { id: "build", label: t("vercel.logs.build") },
            { id: "runtime", label: t("vercel.logs.runtime") },
          ]}
          value={tab}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "build" ? (
          <BuildLogs lines={buildLogs} loading={loading} />
        ) : (
          <RuntimeLogs uid={uid} />
        )}
      </div>
    </section>
  );
}

function BuildLogs({ lines, loading }: { lines: VercelBuildLogLine[]; loading: boolean }) {
  const t = useT();
  if (loading && lines.length === 0) return <Loading fill label={t("vercel.logs.loading")} />;
  if (lines.length === 0) {
    return <p className="p-4 text-[12px] text-muted-foreground">{t("vercel.logs.empty")}</p>;
  }
  return (
    <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed">
      {lines.map((line) => line.text).join("\n")}
    </pre>
  );
}

function RuntimeLogs({ uid }: { uid: string }) {
  const t = useT();
  const [lines, setLines] = useState<VercelRuntimeLogLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getVercelRuntimeLogs(uid)
      .then((next) => {
        if (active) setLines(next);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [uid]);

  if (loading) return <Loading fill label={t("vercel.logs.loading")} />;
  if (error) {
    return (
      <p className="break-words p-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {error}
      </p>
    );
  }
  // An empty list here is ambiguous by design — either nothing was logged, or
  // the account's plan does not serve runtime logs — so the copy says both
  // rather than claiming the deployment was silent.
  if (lines.length === 0) {
    return <p className="p-4 text-[12px] text-muted-foreground">{t("vercel.logs.runtimeEmpty")}</p>;
  }

  return (
    <div className="divide-y divide-border/50 font-mono text-[11px]">
      {lines.map((line) => (
        <div className="flex items-start gap-2 px-3 py-1" key={line.id}>
          <span className="shrink-0 text-muted-foreground">
            {new Date(line.createdAt).toLocaleTimeString()}
          </span>
          {line.statusCode ? (
            <span
              className={cn(
                "shrink-0",
                line.statusCode >= 500
                  ? "text-red-500"
                  : line.statusCode >= 400
                    ? "text-amber-500"
                    : "text-emerald-500",
              )}
            >
              {line.statusCode}
            </span>
          ) : null}
          {line.requestPath ? (
            <span className="shrink-0 max-w-[14rem] truncate text-muted-foreground">
              {[line.requestMethod, line.requestPath].filter(Boolean).join(" ")}
            </span>
          ) : null}
          <span
            className={cn(
              "min-w-0 flex-1 whitespace-pre-wrap break-words",
              line.level === "error" && "text-red-500",
              line.level === "warning" && "text-amber-500",
            )}
          >
            {line.message}
          </span>
        </div>
      ))}
    </div>
  );
}
