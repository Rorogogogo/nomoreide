import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

/**
 * Real, community-run skill directories — not scraped or mirrored, just
 * outbound links. Users copy a SKILL.md URL from one of these and paste it
 * into the card's "Add" input, which already forwards URLs/repos to the
 * agent to fetch and scaffold (see prompts/agent-config.ts).
 */
const SKILL_DIRECTORIES = [
  { label: "SkillsMP", url: "https://skillsmp.com/" },
  { label: "Agent Skill.sh", url: "https://agentskill.sh/" },
  { label: "Claude Marketplaces", url: "https://claudemarketplaces.com/skills" },
];

/**
 * Starter ideas, not verified third-party content: clicking one hands the
 * agent a short brief and lets it scaffold a fresh skill, same as typing a
 * description into Add manually.
 */
const STARTER_IDEAS = [
  { name: "Conventional Commits", description: "Write a Conventional Commits message from the staged diff." },
  { name: "PR Description Writer", description: "Draft a PR description from the branch diff and commit log." },
  { name: "Changelog Generator", description: "Turn merged commits since the last tag into a CHANGELOG entry." },
  { name: "Code Review Checklist", description: "Apply a structured review checklist to a diff before pushing." },
  { name: "Test Case Brainstorm", description: "Enumerate edge cases and missing tests for a function or file." },
];

export interface StarterSkillIdea {
  name: string;
  description: string;
}

export function TrendingSkills({ onInstall }: { onInstall: (idea: StarterSkillIdea) => void }) {
  const t = useT();
  return (
    <div className="border-t border-border/60 bg-muted/20 px-3 py-2">
      <div className="flex flex-wrap gap-1.5">
        {SKILL_DIRECTORIES.map((dir) => (
          <a
            key={dir.url}
            href={dir.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
          >
            {dir.label}
            <ExternalLink className="size-3" />
          </a>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">{t("agent.skills.trendingHint")}</p>
      <ul className="mt-1.5 divide-y divide-border/60">
        {STARTER_IDEAS.map((idea) => (
          <li key={idea.name} className="flex items-center justify-between gap-2 py-1">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">{idea.name}</p>
              <p className="truncate text-[11px] text-muted-foreground" title={idea.description}>
                {idea.description}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-1.5 text-[11px]"
              onClick={() => onInstall(idea)}
            >
              {t("agent.skills.trendingInstall")}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
