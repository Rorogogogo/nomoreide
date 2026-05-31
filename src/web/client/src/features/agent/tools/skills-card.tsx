import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AgentProfile, AgentSkill } from "@/lib/api";
import { useAgentDock } from "../chat/agent-context";
import {
  buildAddSkillPrompt,
  buildAskSkillPrompt,
  buildRemoveSkillPrompt,
} from "../prompts";
import type { AgentId } from "../agent-types";
import { AddButton, AddInline, RowActions } from "./tools-shared";

export function SkillsCard({ agent, agentId }: { agent: AgentProfile; agentId: AgentId }) {
  const { sendToAgent } = useAgentDock();
  const [adding, setAdding] = useState(false);

  function add(input: string) {
    setAdding(false);
    sendToAgent({
      prompt: buildAddSkillPrompt(agentId, input),
      source: { type: "agent-skill", label: "New skill" },
      label: `Add skill: ${input}`,
    });
  }

  function ask(skill: AgentSkill) {
    sendToAgent({
      prompt: buildAskSkillPrompt(skill),
      source: { type: "agent-skill", label: `${skill.name} skill` },
      mode: "draft",
    });
  }

  function remove(skill: AgentSkill) {
    sendToAgent({
      prompt: buildRemoveSkillPrompt(skill),
      source: { type: "agent-skill", label: `Remove ${skill.name}` },
      label: `Remove skill: ${skill.name}`,
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
            <AddButton label="Add a skill with AI" onClick={() => setAdding((value) => !value)} />
          </div>
        </div>
        {adding ? (
          <AddInline
            className="mt-1.5"
            placeholder="Paste a skill URL/repo, or describe the skill…"
            onSubmit={add}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <CardDescription className="text-xs">
            {agentId === "codex"
              ? "User, project, and system skills discovered for Codex."
              : "User and project skills discovered for the active agent."}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {agent.skills.length ? (
          <ul className="divide-y divide-border">
            {agent.skills.map((skill) => (
              <li key={`${skill.scope}:${skill.name}`} className="group px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs font-semibold">{skill.name}</span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Badge variant="outline" size="small">
                      {skill.scope}
                    </Badge>
                    <RowActions
                      askLabel={`Ask AI about the ${skill.name} skill`}
                      removeLabel={`Remove the ${skill.name} skill`}
                      onAsk={() => ask(skill)}
                      onRemove={() => remove(skill)}
                    />
                  </div>
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
  );
}
