import type { ReactNode } from "react";
import {
  Activity,
  Blocks,
  Bot,
  Container,
  Brain,
  Database,
  GitBranch,
  House,
  Inbox,
  Network,
  Puzzle,
  Server,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import type { TranslationKey } from "@/lib/i18n";
import { GitHubLogo } from "@/features/github/github-logo";

export type AppPage =
  | "home"
  | "services"
  | "activity"
  | "servers"
  | "docker"
  | "git"
  | "github"
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
  /**
   * Renders as a collapsible parent with a second layer beneath it.
   *
   * The children are *not* declared here because they are not static: they are
   * whatever is installed, read from `/api/extensions` at runtime. A future
   * downloaded plugin therefore appears in the nav without this file changing —
   * the same property the route registry and the MCP aggregator have.
   */
  expandable?: boolean;
}

export const APP_NAV_SECTIONS: Array<{
  labelKey: TranslationKey;
  items: AppNavigationItem[];
}> = [
  {
    labelKey: "nav.section.run",
    items: [
      /*
        Home leads the first section rather than standing outside the sections.
        A one-item section of its own would render a "HOME ─────" rule above a
        row named Home, and hoisting it out would mean a special case in the
        nav's render loop — which is the thing that loop exists not to have.
      */
      { page: "home", labelKey: "nav.home", icon: <House /> },
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
  /*
    Its own section, and the only one with a second layer.

    Every other section groups by *kind*; this one groups by provenance, and
    that difference is now load-bearing rather than incidental: each installed
    plugin owns a page here (owner's call, §12), so Vercel and Cloudflare are
    two entries rather than one Deploy view with a switcher inside it.

    What did *not* move is a plugin's data. Vultr's instances still merge into
    Servers, because that list is mixed — SSH-discovered machines sit beside
    the Vultr ones — and splitting it by vendor would undo §7's payoff.
  */
  {
    labelKey: "nav.section.extensions",
    items: [
      {
        page: "extensions",
        labelKey: "nav.extensionsInstalled",
        icon: <Blocks />,
        expandable: true,
      },
    ],
  },
];

export const APP_NAV_ITEMS = APP_NAV_SECTIONS.flatMap(
  (section) => section.items,
);
