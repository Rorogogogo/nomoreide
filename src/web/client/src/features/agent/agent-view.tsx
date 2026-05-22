import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Bot,
  Brain,
  ChevronRight,
  FolderOpen,
  Gauge,
  Plug,
  Sparkles,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  getAgentInfo,
  getAgentUsage,
  type AgentInfo,
  type ToolCallRecord,
  type UsageInfo,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  ClaudeLogo,
  CodexLogo,
  GeminiLogo,
  UnknownAgentLogo,
} from "./agent-logos";

type AgentBadgeVariant = "primary" | "secondary" | "success" | "warning";

const AGENT_BADGE: Record<
  AgentInfo["detected"]["name"],
  { label: string; variant: AgentBadgeVariant; icon: React.ReactNode }
> = {
  "claude-code": {
    label: "Claude Code",
    variant: "warning",
    icon: <ClaudeLogo />,
  },
  codex: {
    label: "OpenAI Codex CLI",
    variant: "secondary",
    icon: <CodexLogo />,
  },
  gemini: {
    label: "Gemini CLI",
    variant: "primary",
    icon: <GeminiLogo />,
  },
  unknown: {
    label: "Unknown agent",
    variant: "secondary",
    icon: <UnknownAgentLogo />,
  },
};

type AgentTab = "overview" | "memory" | "tools" | "activity";

const TABS: Array<{ id: AgentTab; label: string; icon: React.ReactNode }> = [
  { id: "overview", label: "Overview", icon: <Gauge className="size-3.5" /> },
  { id: "memory", label: "Memory", icon: <Brain className="size-3.5" /> },
  { id: "tools", label: "Skills & MCPs", icon: <Plug className="size-3.5" /> },
  { id: "activity", label: "Activity", icon: <Activity className="size-3.5" /> },
];

export function AgentView() {
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<AgentTab>("overview");

  useEffect(() => {
    let active = true;
    void getAgentInfo()
      .then((info) => {
        if (active) setAgent(info);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return (
      <div className="h-full overflow-auto bg-card/85 p-4">
        <Alert variant="muted" className="border-destructive/40 text-destructive">
          Failed to load agent info: {error}
        </Alert>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="h-full overflow-auto bg-card/85 p-4">
        <Alert variant="muted">Loading agent info…</Alert>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/85">
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card/90 px-3">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={cn(
              "relative flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium transition-colors",
              tab === entry.id
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {entry.icon}
            {entry.label}
            {tab === entry.id ? (
              <span className="absolute inset-x-1 -bottom-px h-0.5 bg-primary" />
            ) : null}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "overview" ? <OverviewTab agent={agent} /> : null}
        {tab === "memory" ? <MemoryTab agent={agent} /> : null}
        {tab === "tools" ? <ToolsTab agent={agent} /> : null}
        {tab === "activity" ? <ActivityTab agent={agent} /> : null}
      </div>
    </div>
  );
}

function OverviewTab({ agent }: { agent: AgentInfo }) {
  const badge = AGENT_BADGE[agent.detected.name];
  return (
    <>
      <Card className="min-w-0 rounded-none border-0 border-b border-border bg-transparent">
        <CardHeader className="border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-muted-foreground" />
            <CardTitle>Active Agent</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Detected from environment variables and parent process of this MCP server.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={badge.variant}
              appearance="subtle"
              size="medium"
              icon={badge.icon}
            >
              {badge.label}
            </Badge>
            {agent.detected.parentProcess ? (
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                parent: {agent.detected.parentProcess}
              </span>
            ) : null}
          </div>
          {agent.detected.signals.length ? (
            <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
              {agent.detected.signals.map((signal) => (
                <li key={signal}>• {signal}</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No detection signals captured.</p>
          )}
          <div className="pt-1 text-[11px] text-muted-foreground">
            cwd: <span className="font-mono">{agent.project.cwd}</span>
          </div>
        </CardContent>
      </Card>

      <UsageCard />
    </>
  );
}

function MemoryTab({ agent }: { agent: AgentInfo }) {
  return (
    <Card className="min-w-0 rounded-none border-0 bg-transparent">
      <CardHeader className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Brain className="size-4 text-muted-foreground" />
            <CardTitle>Project Memory</CardTitle>
          </div>
          <Badge variant="outline" size="small">
            {agent.project.memoryFiles.length + (agent.project.claudeMdPath ? 1 : 0)}
          </Badge>
        </div>
        <CardDescription className="truncate text-xs">
          {agent.project.memoryDir ?? "No memory directory found for this project."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 p-3">
        {agent.project.claudeMdPath ? (
          <CollapsibleFile
            title="CLAUDE.md"
            preview={agent.project.claudeMdPreview}
            defaultOpen={true}
          />
        ) : null}
        {agent.project.memoryFiles.length ? (
          agent.project.memoryFiles.map((file) => (
            <CollapsibleFile
              key={file.path}
              title={file.name}
              subtitle={`${file.size} B`}
              preview={file.preview}
              defaultOpen={file.name === "MEMORY.md"}
            />
          ))
        ) : !agent.project.claudeMdPath ? (
          <p className="text-xs text-muted-foreground">
            No memory files persisted yet for this project.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ToolsTab({ agent }: { agent: AgentInfo }) {
  return (
    <div className="grid grid-cols-1 divide-y divide-border xl:grid-cols-2 xl:divide-x xl:divide-y-0">
      <Card className="min-w-0 rounded-none border-0 bg-transparent">
        <CardHeader className="border-b border-border px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-muted-foreground" />
              <CardTitle>Skills</CardTitle>
            </div>
            <Badge variant="outline" size="small">
              {agent.skills.length}
            </Badge>
          </div>
          <CardDescription className="text-xs">
            User, project, and plugin skills discovered for the active agent.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {agent.skills.length ? (
            <ul className="divide-y divide-border">
              {agent.skills.map((skill) => (
                <li key={`${skill.scope}:${skill.name}`} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs font-semibold">
                      {skill.name}
                    </span>
                    <Badge variant="outline" size="small">
                      {skill.scope}
                    </Badge>
                  </div>
                  {skill.description ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">{skill.description}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-4 text-xs text-muted-foreground">No skills found.</p>
          )}
        </CardContent>
      </Card>

      <Card className="min-w-0 rounded-none border-0 bg-transparent">
        <CardHeader className="border-b border-border px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Plug className="size-4 text-muted-foreground" />
              <CardTitle>MCP Servers</CardTitle>
            </div>
            <Badge variant="outline" size="small">
              {agent.mcpServers.length}
            </Badge>
          </div>
          <CardDescription className="text-xs">
            From <code className="font-mono">~/.claude.json</code> (user + project scopes).
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {agent.mcpServers.length ? (
            <ul className="divide-y divide-border">
              {agent.mcpServers.map((server) => (
                <li key={`${server.scope}:${server.name}`} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs font-semibold">
                      {server.name}
                    </span>
                    <Badge variant="outline" size="small">
                      {server.scope}
                    </Badge>
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {server.command ?? server.url ?? server.type ?? "—"}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-4 text-xs text-muted-foreground">No MCP servers configured.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ActivityTab({ agent }: { agent: AgentInfo }) {
  return (
    <>
      <ToolCallFeed />

      <Card className="min-w-0 rounded-none border-0 bg-transparent">
        <CardHeader className="border-b border-border px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FolderOpen className="size-4 text-muted-foreground" />
              <CardTitle>Recent Projects</CardTitle>
            </div>
            <Badge variant="outline" size="small">
              {agent.projects.length}
            </Badge>
          </div>
          <CardDescription className="text-xs">
            Most recently active projects known to the agent.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {agent.projects.length ? (
            <ul className="divide-y divide-border">
              {agent.projects.map((project) => (
                <li
                  key={project.path}
                  className={cn(
                    "flex items-start justify-between gap-3 px-3 py-2",
                    project.current && "bg-primary/5",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-xs font-semibold">
                        {project.path}
                      </span>
                      {project.current ? (
                        <Badge variant="success" appearance="subtle" size="small">
                          current
                        </Badge>
                      ) : null}
                    </div>
                    {project.lastSessionFirstPrompt ? (
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {project.lastSessionFirstPrompt}
                      </p>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                    {project.mcpServerCount ? (
                      <div>{project.mcpServerCount} mcp</div>
                    ) : null}
                    {project.lastSessionModified ? (
                      <div>{formatTimestamp(project.lastSessionModified)}</div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-4 text-xs text-muted-foreground">No known projects.</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function CollapsibleFile({
  title,
  subtitle,
  preview,
  defaultOpen = false,
}: {
  title: string;
  subtitle?: string;
  preview?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-md border border-border bg-background/40">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs font-semibold"
      >
        <ChevronRight
          className={cn(
            "size-3.5 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span>{title}</span>
        {subtitle ? (
          <span className="font-mono text-[10px] font-normal text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </button>
      {open && preview ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {preview}
        </pre>
      ) : null}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleString();
}

function UsageCard() {
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => {
      void getAgentUsage()
        .then((info) => {
          if (active) {
            setUsage(info);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (active) setError(err instanceof Error ? err.message : String(err));
        });
    };
    load();
    const interval = window.setInterval(load, 10_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <Card className="min-w-0 rounded-none border-0 bg-transparent">
      <CardHeader className="border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Gauge className="size-4 text-muted-foreground" />
          <CardTitle>Token & Cost Usage</CardTitle>
        </div>
        <CardDescription className="text-xs">
          Last-session metrics from <code className="font-mono">~/.claude.json</code> and rate limits scraped from <code className="font-mono">~/.codex/sessions</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-3">
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {usage?.claude ? <ClaudeUsageBlock usage={usage.claude} /> : null}
          {usage?.codex ? <CodexUsageBlock usage={usage.codex} /> : null}
        </div>
        {!usage?.claude && !usage?.codex && !error ? (
          <p className="text-xs text-muted-foreground">
            No usage data yet. Run a session with Claude Code or Codex CLI in this project.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ClaudeUsageBlock({ usage }: { usage: NonNullable<UsageInfo["claude"]> }) {
  const totalInput =
    usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  const cachePct = totalInput > 0 ? (usage.cacheReadInputTokens / totalInput) * 100 : 0;
  return (
    <div className="rounded-md border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-2">
          <ClaudeLogo className="size-3.5 text-amber-700" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Claude Code · last session
          </span>
          {usage.sessionId ? (
            <span className="font-mono text-[10px] text-muted-foreground">
              {usage.sessionId.slice(0, 8)}
            </span>
          ) : null}
        </div>
        <span className="font-mono text-sm font-semibold text-emerald-700">
          ${usage.costUSD.toFixed(4)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 py-2 text-[11px] sm:grid-cols-4">
        <Stat label="Input" value={formatTokens(usage.inputTokens)} />
        <Stat label="Output" value={formatTokens(usage.outputTokens)} />
        <Stat label="Cache read" value={formatTokens(usage.cacheReadInputTokens)} />
        <Stat label="Cache create" value={formatTokens(usage.cacheCreationInputTokens)} />
        <Stat label="Lines +" value={String(usage.linesAdded)} />
        <Stat label="Lines −" value={String(usage.linesRemoved)} />
        <Stat label="Wall" value={formatDuration(usage.durationMs)} />
        <Stat label="API" value={formatDuration(usage.apiDurationMs)} />
      </div>

      <div className="border-t border-border px-3 py-2">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Cache read share of input</span>
          <span className="font-mono">{cachePct.toFixed(1)}%</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-emerald-500"
            style={{ width: `${Math.min(100, cachePct).toFixed(2)}%` }}
          />
        </div>
      </div>

      {usage.fiveHour || usage.weekly ? (
        <div className="space-y-2 border-t border-border px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Rate limits
          </div>
          {usage.fiveHour ? <UsageBar label="5h block" window={usage.fiveHour} /> : null}
          {usage.weekly ? <UsageBar label="This week" window={usage.weekly} /> : null}
        </div>
      ) : null}

      {usage.models.length ? (
        <div className="space-y-1 border-t border-border px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            By model
          </div>
          {usage.models.map((model) => (
            <div
              key={model.model}
              className="flex items-center justify-between gap-2 font-mono text-[11px]"
            >
              <span className="truncate">{model.model}</span>
              <span className="shrink-0 text-muted-foreground">
                {formatTokens(model.inputTokens + model.outputTokens)} tok ·{" "}
                <span className="text-emerald-700">${model.costUSD.toFixed(4)}</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CodexUsageBlock({ usage }: { usage: NonNullable<UsageInfo["codex"]> }) {
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-2">
          <CodexLogo className="size-3.5 text-foreground" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Codex · rate limits
          </span>
        </div>
        {usage.timestamp ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            {new Date(usage.timestamp).toLocaleString()}
          </span>
        ) : null}
      </div>
      <div className="space-y-2 px-3 py-2">
        {usage.primary ? <UsageBar label="5h window" window={usage.primary} /> : null}
        {usage.secondary ? <UsageBar label="Weekly window" window={usage.secondary} /> : null}
      </div>
    </div>
  );
}

function UsageBar({
  label,
  window: window_,
}: {
  label: string;
  window: { usedPercent: number; resetsAtUnix: number };
}) {
  const pct = Math.min(100, Math.max(0, window_.usedPercent));
  const resetsAt = window_.resetsAtUnix
    ? new Date(window_.resetsAtUnix * 1000).toLocaleString()
    : null;
  const tone = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">{pct.toFixed(1)}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full", tone)} style={{ width: `${pct.toFixed(2)}%` }} />
      </div>
      {resetsAt ? (
        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
          resets {resetsAt}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-xs font-semibold">{value}</div>
    </div>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatDuration(ms: number): string {
  if (!ms) return "0s";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remSeconds}s`;
}

const MAX_RECORDS = 100;

function ToolCallFeed() {
  const [records, setRecords] = useState<ToolCallRecord[]>([]);
  const [connected, setConnected] = useState(false);
  const seenIds = useRef<Set<number>>(new Set());

  useEffect(() => {
    const source = new EventSource("/api/agent/tool-calls/stream");
    source.addEventListener("open", () => setConnected(true));
    source.addEventListener("error", () => setConnected(false));
    source.addEventListener("tool-call", (event) => {
      try {
        const record = JSON.parse((event as MessageEvent).data) as ToolCallRecord;
        setRecords((prev) => {
          if (seenIds.current.has(record.id)) return prev;
          seenIds.current.add(record.id);
          const next = [...prev, record];
          if (next.length > MAX_RECORDS) next.splice(0, next.length - MAX_RECORDS);
          return next;
        });
      } catch {
        // ignore malformed events
      }
    });
    return () => {
      source.close();
    };
  }, []);

  const visible = [...records].reverse();

  return (
    <Card className="min-w-0 rounded-none border-0 border-b border-border bg-transparent">
      <CardHeader className="border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            <CardTitle>Live MCP Tool Calls</CardTitle>
            <Badge variant="outline" size="small">
              {records.length}
            </Badge>
          </div>
          <Badge
            variant={connected ? "success" : "secondary"}
            appearance="subtle"
            size="small"
            icon={
              <span
                className={cn(
                  "inline-block size-1.5 rounded-full",
                  connected ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/60",
                )}
              />
            }
          >
            {connected ? "live" : "reconnecting…"}
          </Badge>
        </div>
        <CardDescription className="text-xs">
          Streamed from this NoMoreIDE MCP server. Newest at the top.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {visible.length ? (
          <ul className="max-h-96 divide-y divide-border overflow-auto">
            {visible.map((record) => (
              <li key={record.id} className="px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs font-semibold">
                    {record.tool}
                  </span>
                  <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-muted-foreground">
                    <span>{record.durationMs} ms</span>
                    <Badge
                      variant={record.status === "ok" ? "success" : "danger"}
                      appearance="subtle"
                      size="small"
                    >
                      {record.status}
                    </Badge>
                  </div>
                </div>
                {record.args ? (
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {record.args}
                  </div>
                ) : null}
                {record.error ? (
                  <div className="mt-0.5 font-mono text-[11px] text-destructive">
                    {record.error}
                  </div>
                ) : null}
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/80">
                  {new Date(record.startedAt).toLocaleTimeString()}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            No tool calls yet. Invoke a NoMoreIDE MCP tool from your agent and it will appear here.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
