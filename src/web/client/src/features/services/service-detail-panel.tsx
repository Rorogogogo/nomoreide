import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { ServiceHealth, ServiceStatus, TimelineEvent } from "@/lib/api";
import { cn } from "@/lib/utils";
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
  const [tab, setTab] = useState<Tab>("logs");
  const processes = health?.processTree?.processes ?? [];

  return (
    <div className="border-t border-border bg-muted/30 px-3 py-2 text-xs">
      <div className="mb-2 flex gap-1">
        <TabButton active={tab === "logs"} onClick={() => setTab("logs")}>
          Logs
        </TabButton>
        <TabButton active={tab === "processes"} onClick={() => setTab("processes")}>
          Processes {processes.length ? <Badge variant="secondary" size="small">{processes.length}</Badge> : null}
        </TabButton>
        <TabButton active={tab === "metrics"} onClick={() => setTab("metrics")}>
          Metrics
        </TabButton>
        <TabButton active={tab === "http"} onClick={() => setTab("http")}>
          HTTP
          {status?.inspector?.enabled ? (
            <Badge variant="success" size="small">on</Badge>
          ) : null}
        </TabButton>
        <TabButton active={tab === "env"} onClick={() => setTab("env")}>
          Env
        </TabButton>
        <TabButton active={tab === "tests"} onClick={() => setTab("tests")}>
          Tests
        </TabButton>
        <TabButton active={tab === "terminal"} onClick={() => setTab("terminal")}>
          Terminal
        </TabButton>
      </div>
      {tab === "processes" ? <ProcessesTab rows={processes} /> : null}
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
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
