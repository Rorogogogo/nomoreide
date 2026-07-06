import { Stethoscope } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useRegisterRefresh } from "@/components/refresh-registry";
import { AgentColumn } from "./agent-column";
import { useAgentEnv } from "./use-agent-env";

/**
 * Agent Environments (ROR-60): a read-only, side-by-side view of each coding
 * agent's live MCP servers and skills. Copy/move actions arrive with the
 * staged-writes slice (ROR-61).
 */
export function AgentEnvView() {
  const { agents, configs, doctor, loading, error, refresh } = useAgentEnv();
  useRegisterRefresh(refresh);

  const availabilityByAgent = new Map(agents.map((agent) => [agent.agent, agent]));
  const warnings = doctor?.checks.filter((check) => check.status !== "ok") ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
      {error ? <Alert variant="muted">{error}</Alert> : null}
      {loading && configs.length === 0 ? (
        <Alert variant="muted">Reading agent configurations...</Alert>
      ) : null}

      {warnings.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/70 px-3 py-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Stethoscope className="size-3.5" />
            Doctor
          </span>
          {warnings.map((check) => (
            <Badge key={check.message} size="small" variant="warning">
              {check.message}
            </Badge>
          ))}
        </div>
      ) : null}

      {!loading && configs.length === 0 && !error ? (
        <Alert variant="muted">
          No agent configurations found. Agent Environments reads Claude Code, Codex CLI,
          and Antigravity configs from your home directory.
        </Alert>
      ) : null}

      {configs.length > 0 ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {configs.map((config) => (
            <AgentColumn
              key={config.agent}
              availability={availabilityByAgent.get(config.agent)}
              config={config}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
