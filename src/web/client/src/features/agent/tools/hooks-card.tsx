import { useState } from "react";
import { Webhook } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AgentHook, AgentProfile } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useAgentDock } from "../chat/agent-context";
import { AiContextTarget } from "../context-menu/ai-context-menu";
import {
  buildAddHookPrompt,
  buildAskHookPrompt,
  buildRemoveHookPrompt,
} from "../prompts";
import type { AgentId } from "../agent-types";
import { AddButton, AddInline } from "./tools-shared";

export function HooksCard({
  agent,
  agentId,
  alternateHooks,
}: {
  agent: AgentProfile;
  agentId: AgentId;
  alternateHooks?: { agentLabel: string; count: number };
}) {
  const { sendToAgent } = useAgentDock();
  const [adding, setAdding] = useState(false);
  const hooks = agent.hooks ?? [];
  const t = useT();

  function add(input: string) {
    setAdding(false);
    sendToAgent({
      prompt: buildAddHookPrompt(agentId, input),
      source: { type: "agent-hook", label: t("agent.hooks.sourceNew") },
      label: t("agent.hooks.addAction", { input }),
    });
  }

  return (
    <Card className="min-w-0 rounded-none border-0 border-t border-border bg-transparent md:border-l lg:border-t-0">
      <CardHeader className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Webhook className="size-4 text-muted-foreground" />
            <CardTitle>Hooks</CardTitle>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" size="small">
              {hooks.length}
            </Badge>
            <AddButton label={t("agent.hooks.addLabel")} onClick={() => setAdding((value) => !value)} />
          </div>
        </div>
        {adding ? (
          <AddInline
            className="mt-1.5"
            placeholder={t("agent.hooks.addPlaceholder")}
            onSubmit={add}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <CardDescription className="text-xs">
            {agentId === "codex" ? t("agent.hooks.descCodex") : t("agent.hooks.desc")}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {hooks.length ? (
          <ul className="divide-y divide-border">
            {hooks.map((hook) => (
              <AiContextTarget
                key={hook.id}
                target={{
                  label: hook.event,
                  intents: [
                    {
                      id: "ask-hook",
                      label: t("agent.hooks.askLabel", { event: hook.event }),
                      resolvePrompt: () => buildAskHookPrompt(hook),
                      source: { type: "agent-hook", label: t("agent.hooks.sourceHook", { event: hook.event }) },
                    },
                    {
                      id: "remove-hook",
                      label: t("agent.hooks.removeLabel", { event: hook.event }),
                      resolvePrompt: () => buildRemoveHookPrompt(hook),
                      source: { type: "agent-hook", label: t("agent.hooks.sourceRemove", { event: hook.event }) },
                      agentLabel: t("agent.hooks.removeAction", { event: hook.event }),
                    },
                  ],
                }}
              >
              <li
                className="group px-3 py-2 hover:bg-muted/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <span
                      className="min-w-0 truncate font-mono text-xs font-semibold"
                      title={hook.event}
                    >
                      {hook.event}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <HookStatusBadge hook={hook} />
                    <HookTrustBadge hook={hook} />
                    <Badge variant="outline" size="small">
                      {hook.scope}
                    </Badge>
                  </div>
                </div>
                <div
                  className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                  title={formatHookSummary(hook)}
                >
                  {formatHookSummary(hook)}
                </div>
              </li>
              </AiContextTarget>
            ))}
          </ul>
        ) : (
          <EmptyHooks agentId={agentId} alternateHooks={alternateHooks} />
        )}
      </CardContent>
    </Card>
  );
}

function EmptyHooks({
  agentId,
  alternateHooks,
}: {
  agentId: AgentId;
  alternateHooks?: { agentLabel: string; count: number };
}) {
  const t = useT();
  const selectedAgent = agentId === "codex" ? "Codex" : "Claude Code";
  return (
    <p className="px-3 py-4 text-xs text-muted-foreground">
      {t("agent.hooks.emptyFor", { agent: selectedAgent })}
      {alternateHooks?.count
        ? t("agent.hooks.emptyAlternate", {
            agent: alternateHooks.agentLabel,
            count: alternateHooks.count,
          })
        : null}
    </p>
  );
}

function HookStatusBadge({ hook }: { hook: AgentHook }) {
  const t = useT();
  if (hook.status === "enabled") {
    return (
      <Badge variant="success" appearance="subtle" size="small">
        {t("agent.hooks.enabled")}
      </Badge>
    );
  }
  if (hook.status === "disabled") {
    return (
      <Badge variant="error" appearance="subtle" size="small">
        {t("agent.hooks.disabled")}
      </Badge>
    );
  }
  return (
    <Badge variant="warning" appearance="subtle" size="small">
      {t("agent.hooks.default")}
    </Badge>
  );
}

function HookTrustBadge({ hook }: { hook: AgentHook }) {
  const t = useT();
  if (hook.trusted === undefined) return null;
  return (
    <Badge
      variant={hook.trusted ? "success" : "warning"}
      appearance="subtle"
      size="small"
    >
      {hook.trusted ? t("agent.hooks.trusted") : t("agent.hooks.untrusted")}
    </Badge>
  );
}

function formatHookCommand(hook: AgentHook): string {
  if (hook.command) return hook.command;
  return hook.type ?? hook.settingsPath;
}

function formatHookSummary(hook: AgentHook): string {
  const matcher = hook.matcher ? `matcher ${hook.matcher} · ` : "";
  return `${matcher}${formatHookCommand(hook)}`;
}
