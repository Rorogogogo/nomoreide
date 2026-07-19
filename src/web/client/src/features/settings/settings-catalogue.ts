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

/** Search copy for implemented controls. Keep this beside category metadata so
 * adding a setting also requires making its label and description discoverable. */
export const SETTING_SEARCH_TEXT: Record<SettingsCategoryId, string> = {
  general: "Language language preference Dock sidebar keep navigation expanded Default project scope run pages all projects selected project",
  appearance: "Theme system light dark Interface density adjust spacing Code font size code and log surfaces Reduced motion movement animated transitions",
  terminal: "Terminal font size text sessions Cursor style active cursor Scrollback limit previous terminal lines memory Copy on select clipboard Confirm before terminating closing stopping restarting running process danger confirmation",
  "services-logs": "Show timestamps time gutter log entry Wrap log lines long output horizontal scrolling",
  "git-github": "GitHub connection credentials repository defaults Git preferences",
  "agents-mcp": "Agent environments installed agents MCP servers skills profiles project agent context",
  "database-safety": "Confirm before writes danger confirmation write statements Default result limit maximum rows query connections write access",
  notifications: "Desktop notifications browser permission alerts",
  "data-privacy": "Local settings storage browser operational config export reset controls",
  about: "Version console documentation runtime docs support",
};

export function categoryById(id: SettingsCategoryId): SettingsCategory {
  return SETTINGS_CATEGORIES.find((category) => category.id === id) ?? SETTINGS_CATEGORIES[0];
}
