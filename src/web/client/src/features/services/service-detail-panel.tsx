import { Badge } from "@/components/ui/badge";
import type { ServiceHealth, ServiceStatus, TimelineEvent } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { usePersistentState } from "@/lib/use-persistent-state";
import { EnvTab } from "./service-detail/env-tab";
import { HttpTab } from "./service-detail/http-tab";
import { LogsTab } from "./service-detail/logs-tab";
import { MetricsTab } from "./service-detail/metrics-tab";
import { ProcessesTab } from "./service-detail/processes-tab";
import { TerminalTab } from "./service-detail/terminal-tab";
import { TestsTab } from "./service-detail/tests-tab";

type Tab = "processes" | "metrics" | "http" | "env" | "tests" | "logs" | "terminal";

export function ServiceDetailPanel({
  serviceName,
  status,
  health,
  timeline,
  onRefresh,
}: {
  serviceName: string;
  status?: ServiceStatus;
  health?: ServiceHealth;
  timeline: TimelineEvent[];
  onRefresh: () => Promise<void>;
}) {
  const t = useT();
  // Sticky so reopening a service lands on the tab you last used.
  const [tab, setTab] = usePersistentState<Tab>("service-detail:tab", "metrics");
  const processes = health?.processTree?.processes ?? [];

  return (
    <div className="min-h-full bg-background text-xs">
      <div
        aria-label={t("services.title")}
        className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-border bg-background/95 px-3 py-2 backdrop-blur-sm"
        role="tablist"
      >
        <TabButton active={tab === "logs"} onClick={() => setTab("logs")}>
          {t("services.logs")}
        </TabButton>
        <TabButton active={tab === "processes"} onClick={() => setTab("processes")}>
          {t("services.tab.processes")} {processes.length ? <Badge variant="secondary" size="small">{processes.length}</Badge> : null}
        </TabButton>
        <TabButton active={tab === "metrics"} onClick={() => setTab("metrics")}>
          {t("services.tab.metrics")}
        </TabButton>
        <TabButton active={tab === "http"} onClick={() => setTab("http")}>
          HTTP
          {status?.inspector?.enabled ? (
            <Badge variant="success" size="small">{t("services.tab.on")}</Badge>
          ) : null}
        </TabButton>
        <TabButton active={tab === "env"} onClick={() => setTab("env")}>
          {t("services.tab.env")}
        </TabButton>
        <TabButton active={tab === "tests"} onClick={() => setTab("tests")}>
          {t("services.tab.tests")}
        </TabButton>
        <TabButton active={tab === "terminal"} onClick={() => setTab("terminal")}>
          {t("nav.terminal")}
        </TabButton>
      </div>
      <div className="p-3">
        {tab === "processes" ? (
          <ProcessesTab rows={processes} running={status?.state === "running"} />
        ) : null}
        {tab === "metrics" ? <MetricsTab serviceName={serviceName} /> : null}
        {tab === "http" ? (
          <HttpTab
            serviceName={serviceName}
            status={status}
            timeline={timeline}
            onRefresh={onRefresh}
          />
        ) : null}
        {tab === "env" ? <EnvTab serviceName={serviceName} /> : null}
        {tab === "tests" ? <TestsTab serviceName={serviceName} /> : null}
        {tab === "logs" ? <LogsTab serviceName={serviceName} /> : null}
        {/* Kept mounted (hidden when inactive) so the shell survives tab switches;
            keyed by service so switching services tears down and reopens it. */}
        <TerminalTab
          key={serviceName}
          active={tab === "terminal"}
          serviceName={serviceName}
        />
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-selected={active}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {children}
    </button>
  );
}
