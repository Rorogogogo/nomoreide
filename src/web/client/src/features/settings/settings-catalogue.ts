import {
  Bell,
  Bot,
  Database,
  GitBranch,
  Info,
  Languages,
  Palette,
  Server,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";

export type SettingsCategoryId =
  | "general"
  | "appearance"
  | "terminal"
  | "services-logs"
  | "git-github"
  | "agents-mcp"
  | "database-safety"
  | "notifications"
  | "data-privacy"
  | "about";

export type SettingsScope = "global" | "project" | "mixed";

export interface SettingsCategory {
  id: SettingsCategoryId;
  label: string;
  description: string;
  icon: LucideIcon;
  scope: SettingsScope;
  keywords: string[];
}

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  { id: "general", label: "General", description: "Language, navigation, and startup context.", icon: Languages, scope: "global", keywords: ["language", "sidebar", "project scope"] },
  { id: "appearance", label: "Appearance", description: "Theme, density, type size, and motion.", icon: Palette, scope: "global", keywords: ["theme", "dark", "light", "font", "motion"] },
  { id: "terminal", label: "Terminal", description: "Terminal rendering and process safeguards.", icon: SquareTerminal, scope: "global", keywords: ["shell", "cursor", "scrollback", "copy", "terminate"] },
  { id: "services-logs", label: "Services & Logs", description: "How this project presents runtime output.", icon: Server, scope: "project", keywords: ["timestamps", "wrap", "runtime", "services"] },
  { id: "git-github", label: "Git & GitHub", description: "Source-control preferences and connection status.", icon: GitBranch, scope: "mixed", keywords: ["git", "github", "co-author", "repository"] },
  { id: "agents-mcp", label: "Agents & MCP", description: "Agent environments and MCP management.", icon: Bot, scope: "mixed", keywords: ["agent", "model", "mcp", "claude", "codex"] },
  { id: "database-safety", label: "Database & Safety", description: "Project query limits and write safeguards.", icon: Database, scope: "project", keywords: ["database", "sql", "danger confirmation", "writes", "limit"] },
  { id: "notifications", label: "Notifications", description: "Browser notification capability and permission.", icon: Bell, scope: "global", keywords: ["alerts", "desktop", "permission"] },
  { id: "data-privacy", label: "Data & Privacy", description: "Local storage, export, reset, and privacy.", icon: ShieldCheck, scope: "mixed", keywords: ["data", "privacy", "export", "reset", "storage"] },
  { id: "about", label: "About", description: "Version, runtime, documentation, and support.", icon: Info, scope: "global", keywords: ["version", "docs", "runtime", "issues"] },
];

export interface SearchableSettingCopy { label: string; description: string }

/** Exact visible setting copy used to build the search index. */
export const SEARCHABLE_SETTINGS: Record<SettingsCategoryId, SearchableSettingCopy[]> = {
  general: [
    { label: "Language", description: "Choose the language preference for this console." },
    { label: "Dock sidebar", description: "Keep the navigation expanded while you work." },
    { label: "Default project scope", description: "Choose whether Run pages open across every project or the selected project." },
  ],
  appearance: [
    { label: "Theme", description: "Follow your system or choose an explicit dashboard theme." },
    { label: "Interface density", description: "Adjust spacing throughout the control surface." },
    { label: "Code font size", description: "Size used by code and log surfaces." },
    { label: "Reduced motion", description: "Reduce non-essential movement and animated transitions." },
  ],
  terminal: [
    { label: "Terminal font size", description: "Text size for terminal sessions." },
    { label: "Cursor style", description: "Shape of the active terminal cursor." },
    { label: "Scrollback limit", description: "Number of previous terminal lines kept in memory." },
    { label: "Copy on select", description: "Copy selected terminal text to the clipboard." },
    { label: "Confirm before terminating", description: "Ask before closing, stopping, or restarting a running process. Danger confirmation." },
  ],
  "services-logs": [
    { label: "Show timestamps", description: "Show the time gutter beside each log entry." },
    { label: "Wrap log lines", description: "Wrap long output instead of scrolling horizontally." },
  ],
  "git-github": [
    { label: "GitHub connection", description: "Review the current GitHub connection without exposing credentials here." },
    { label: "Repository defaults", description: "Repository-specific Git preferences will appear when their behavior is available." },
  ],
  "agents-mcp": [
    { label: "Agent environments", description: "Manage installed agents, MCP servers, skills, and profiles." },
    { label: "Project agent context", description: "Project-specific agent configuration remains in Agent Environments." },
  ],
  "database-safety": [
    { label: "Confirm before writes", description: "Show a danger confirmation before write statements are submitted." },
    { label: "Default result limit", description: "Maximum rows requested for a default browse or query." },
    { label: "Connections", description: "Manage connections and write access in the Database workbench." },
  ],
  notifications: [{ label: "Desktop notifications", description: "Desktop notifications are not supported in this environment. Browser permission controls arrive with notification events." }],
  "data-privacy": [
    { label: "Local settings storage", description: "UI preferences stay in local browser storage; operational settings live in your NoMoreIDE config directory." },
    { label: "Export and reset", description: "Export and reset controls are coming in a later delivery." },
  ],
  about: [
    { label: "Version", description: "Application version." },
    { label: "Console", description: "Local runtime address." },
    { label: "Documentation", description: "NoMoreIDE documentation and support." },
  ],
};

export const SETTING_SEARCH_TEXT = Object.fromEntries(
  Object.entries(SEARCHABLE_SETTINGS).map(([id, items]) => [
    id,
    items.flatMap((item) => [item.label, item.description]).join(" "),
  ]),
) as Record<SettingsCategoryId, string>;


export function categoryById(id: SettingsCategoryId): SettingsCategory {
  return SETTINGS_CATEGORIES.find((category) => category.id === id) ?? SETTINGS_CATEGORIES[0];
}
