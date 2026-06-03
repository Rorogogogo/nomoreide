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
import { useAgentDock } from "../chat/agent-context";
import {
  buildAddHookPrompt,
  buildAskHookPrompt,
  buildRemoveHookPrompt,
} from "../prompts";
import type { AgentId } from "../agent-types";
import { AddButton, AddInline, RowActions } from "./tools-shared";

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

  function add(input: string) {
    setAdding(false);
    sendToAgent({
      prompt: buildAddHookPrompt(agentId, input),
      source: { type: "agent-hook", label: "New hook" },
      label: `Add hook: ${input}`,
    });
  }

  function ask(hook: AgentHook) {
    sendToAgent({
      prompt: buildAskHookPrompt(hook),
      source: { type: "agent-hook", label: `${hook.event} hook` },
      mode: "draft",
    });
  }

  function remove(hook: AgentHook) {
    sendToAgent({
      prompt: buildRemoveHookPrompt(hook),
      source: { type: "agent-hook", label: `Remove ${hook.event}` },
      label: `Remove hook: ${hook.event}`,
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
            <AddButton label="Add a hook with AI" onClick={() => setAdding((value) => !value)} />
          </div>
        </div>
        {adding ? (
          <AddInline
            className="mt-1.5"
            placeholder="Describe the event, matcher, and command…"
            onSubmit={add}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <CardDescription className="text-xs">
            {agentId === "codex"
              ? "Codex hooks from ~/.codex/hooks.json, with state from ~/.codex/config.toml."
              : "PreToolUse, PostToolUse, and other Claude Code hooks from user and project settings."}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {hooks.length ? (
          <ul className="divide-y divide-border">
            {hooks.map((hook) => (
              <li
                key={hook.id}
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
                    <RowActions
                      askLabel={`Ask AI about the ${hook.event} hook`}
                      removeLabel={`Remove the ${hook.event} hook`}
                      onAsk={() => ask(hook)}
                      onRemove={() => remove(hook)}
                    />
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
  const selectedAgent = agentId === "codex" ? "Codex" : "Claude Code";
  return (
    <p className="px-3 py-4 text-xs text-muted-foreground">
      No {selectedAgent} hooks configured.
      {alternateHooks?.count ? (
        <>
          {" "}
          {alternateHooks.agentLabel} has {alternateHooks.count} hook
          {alternateHooks.count === 1 ? "" : "s"}; switch agents above to view them.
        </>
      ) : null}
    </p>
  );
}

function HookStatusBadge({ hook }: { hook: AgentHook }) {
  if (hook.status === "enabled") {
    return (
      <Badge variant="success" appearance="subtle" size="small">
        Enabled
      </Badge>
    );
  }
  if (hook.status === "disabled") {
    return (
      <Badge variant="error" appearance="subtle" size="small">
        Disabled
      </Badge>
    );
  }
  return (
    <Badge variant="warning" appearance="subtle" size="small">
      Default
    </Badge>
  );
}

function HookTrustBadge({ hook }: { hook: AgentHook }) {
  if (hook.trusted === undefined) return null;
  return (
    <Badge
      variant={hook.trusted ? "success" : "warning"}
      appearance="subtle"
      size="small"
    >
      {hook.trusted ? "Trusted" : "Untrusted"}
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
