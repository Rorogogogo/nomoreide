import { useState } from "react";
import { Compass, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AgentProfile } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useAgentDock } from "../chat/agent-context";
import { AiContextTarget } from "../context-menu/ai-context-menu";
import {
  buildAddSkillPrompt,
  buildAskSkillPrompt,
  buildRemoveSkillPrompt,
} from "../prompts";
import type { AgentId } from "../agent-types";
import { AddButton, AddInline } from "./tools-shared";
import { TrendingSkills, type StarterSkillIdea } from "./trending-skills";

export function SkillsCard({ agent, agentId }: { agent: AgentProfile; agentId: AgentId }) {
  const { sendToAgent } = useAgentDock();
  const [adding, setAdding] = useState(false);
  const [trending, setTrending] = useState(false);
  const t = useT();

  function add(input: string) {
    setAdding(false);
    sendToAgent({
      prompt: buildAddSkillPrompt(agentId, input),
      source: { type: "agent-skill", label: t("agent.skills.sourceNew") },
      label: t("agent.skills.addAction", { input }),
    });
  }

  function installTrending(idea: StarterSkillIdea) {
    setTrending(false);
    const input = `${idea.name} — ${idea.description}`;
    sendToAgent({
      prompt: buildAddSkillPrompt(agentId, input),
      source: { type: "agent-skill", label: t("agent.skills.sourceTrending", { name: idea.name }) },
      label: t("agent.skills.addAction", { input: idea.name }),
    });
  }

  return (
    <Card className="min-w-0 rounded-none border-0 bg-transparent">
      <CardHeader className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-muted-foreground" />
            <CardTitle>Skills</CardTitle>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" size="small">
              {agent.skills.length}
            </Badge>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-[11px] font-medium"
              onClick={() => setTrending((value) => !value)}
              title={t("agent.skills.trendingLabel")}
              aria-label={t("agent.skills.trendingLabel")}
              aria-pressed={trending}
            >
              <Compass className="size-3.5" />
            </Button>
            <AddButton label={t("agent.tools.addSkillLabel")} onClick={() => setAdding((value) => !value)} />
          </div>
        </div>
        {adding ? (
          <AddInline
            className="mt-1.5"
            placeholder={t("agent.tools.addSkillPlaceholder")}
            onSubmit={add}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <CardDescription className="text-xs">
            {agentId === "codex" ? t("agent.skills.descCodex") : t("agent.skills.desc")}
          </CardDescription>
        )}
      </CardHeader>
      {trending ? <TrendingSkills onInstall={installTrending} /> : null}
      <CardContent className="p-0">
        {agent.skills.length ? (
          <ul className="divide-y divide-border">
            {agent.skills.map((skill) => (
              <AiContextTarget
                key={`${skill.scope}:${skill.name}`}
                target={{
                  label: skill.name,
                  intents: [
                    {
                      id: "ask-skill",
                      label: t("agent.skills.askLabel", { name: skill.name }),
                      resolvePrompt: () => buildAskSkillPrompt(skill),
                      source: { type: "agent-skill", label: t("agent.skills.sourceSkill", { name: skill.name }) },
                    },
                    {
                      id: "remove-skill",
                      label: t("agent.skills.removeLabel", { name: skill.name }),
                      resolvePrompt: () => buildRemoveSkillPrompt(skill),
                      source: { type: "agent-skill", label: t("agent.skills.sourceRemove", { name: skill.name }) },
                      agentLabel: t("agent.skills.removeAction", { name: skill.name }),
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
                      title={skill.name}
                    >
                      {skill.name}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Badge variant="outline" size="small">
                      {skill.scope}
                    </Badge>
                  </div>
                </div>
                {skill.description ? (
                  <p className="mt-1 truncate text-[11px] text-muted-foreground" title={skill.description}>
                    {skill.description}
                  </p>
                ) : null}
              </li>
              </AiContextTarget>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-4 text-xs text-muted-foreground">{t("agent.skills.empty")}</p>
        )}
      </CardContent>
    </Card>
  );
}
