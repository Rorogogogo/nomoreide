import type { ReactNode } from "react";
import {
  Activity,
  Blocks,
  Bot,
  Container,
  Brain,
  Database,
  GitBranch,
  Inbox,
  Network,
  Puzzle,
  Server,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import type { TranslationKey } from "@/lib/i18n";
import { GitHubLogo } from "@/features/github/github-logo";
import { ProviderLogo } from "@/features/deploy/provider-logo";

export type AppPage =
  | "services"
  | "activity"
  | "servers"
  | "docker"
  | "git"
  | "github"
  | "deploy"
  | "workflows"
  | "agent"
  | "agent-env"
  | "context"
  | "extensions"
  | "errors"
  | "database"
  | "terminal"
  | "settings";

export interface AppNavigationItem {
  page: Exclude<AppPage, "settings">;
  labelKey: TranslationKey;
  icon: ReactNode;
}

export const APP_NAV_SECTIONS: Array<{
  labelKey: TranslationKey;
  items: AppNavigationItem[];
}> = [
  {
    labelKey: "nav.section.run",
    items: [
      { page: "services", labelKey: "nav.services", icon: <Server /> },
      { page: "activity", labelKey: "nav.activity", icon: <Activity /> },
      { page: "servers", labelKey: "nav.servers", icon: <Network /> },
      { page: "docker", labelKey: "nav.docker", icon: <Container /> },
      { page: "errors", labelKey: "nav.errors", icon: <Inbox /> },
      { page: "terminal", labelKey: "nav.terminal", icon: <SquareTerminal /> },
    ],
  },
  {
    labelKey: "nav.section.code",
    items: [
      { page: "git", labelKey: "nav.git", icon: <GitBranch /> },
      { page: "github", labelKey: "nav.github", icon: <GitHubLogo /> },
      // Repo-scoped like Git/GitHub — it follows the selected project, so it
      // belongs beside them rather than under Run with the local services.
      { page: "deploy", labelKey: "nav.deploy", icon: <ProviderLogo /> },
      { page: "workflows", labelKey: "nav.workflows", icon: <Workflow /> },
    ],
  },
  {
    labelKey: "nav.section.data",
    items: [{ page: "database", labelKey: "nav.database", icon: <Database /> }],
  },
  {
    labelKey: "nav.section.agent",
    items: [
      { page: "agent", labelKey: "nav.agentConsole", icon: <Bot /> },
      { page: "context", labelKey: "nav.context", icon: <Brain /> },
      { page: "agent-env", labelKey: "nav.agentEnv", icon: <Puzzle /> },
    ],
  },
  // Its own section rather than a row under another, because it groups by
  // provenance where every other section groups by kind — and that difference
  // is the point: extensions are *managed* here, while their features stay
  // under the kind they belong to (Deploy, Servers). See §12 of the plan.
  {
    labelKey: "nav.section.extensions",
    items: [
      { page: "extensions", labelKey: "nav.extensionsInstalled", icon: <Blocks /> },
    ],
  },
];

export const APP_NAV_ITEMS = APP_NAV_SECTIONS.flatMap(
  (section) => section.items,
);
