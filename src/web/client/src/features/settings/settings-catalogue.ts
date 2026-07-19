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
import type { TranslationKey } from "@/lib/i18n";

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

export const SETTING_COPY = {
  language: { category: "general", label: "Language", description: "Choose the language preference for this console." },
  "sidebar-docked": { category: "general", label: "Dock sidebar", description: "Keep the navigation expanded while you work." },
  "project-scope": { category: "general", label: "Default project scope", description: "Choose whether Run pages open across every project or the selected project." },
  theme: { category: "appearance", label: "Theme", description: "Follow your system or choose an explicit dashboard theme." },
  density: { category: "appearance", label: "Interface density", description: "Adjust spacing throughout the control surface." },
  "code-font": { category: "appearance", label: "Code font size", description: "Size used by code and log surfaces." },
  "reduced-motion": { category: "appearance", label: "Reduced motion", description: "Reduce non-essential movement and animated transitions." },
  "terminal-font": { category: "terminal", label: "Terminal font size", description: "Text size for terminal sessions." },
  cursor: { category: "terminal", label: "Cursor style", description: "Shape of the active terminal cursor." },
  scrollback: { category: "terminal", label: "Scrollback limit", description: "Number of previous terminal lines kept in memory." },
  "copy-on-select": { category: "terminal", label: "Copy on select", description: "Copy selected terminal text to the clipboard." },
  "confirm-terminate": { category: "terminal", label: "Confirm before terminating", description: "Ask before closing, stopping, or restarting a running process. Danger confirmation." },
  "log-timestamps": { category: "services-logs", label: "Show timestamps", description: "Show the time gutter beside each log entry." },
  "wrap-lines": { category: "services-logs", label: "Wrap log lines", description: "Wrap long output instead of scrolling horizontally." },
  "github-connection": { category: "git-github", label: "GitHub connection", description: "Review the current GitHub connection without exposing credentials here." },
  "repository-defaults": { category: "git-github", label: "Repository defaults", description: "Repository-specific Git preferences will appear when their behavior is available." },
  "agent-environments": { category: "agents-mcp", label: "Agent environments", description: "Manage installed agents, MCP servers, skills, and profiles." },
  "project-agent-context": { category: "agents-mcp", label: "Project agent context", description: "Project-specific agent configuration remains in Agent Environments." },
  "confirm-writes": { category: "database-safety", label: "Confirm before writes", description: "Show a danger confirmation before write statements are submitted." },
  "result-limit": { category: "database-safety", label: "Default result limit", description: "Maximum rows requested for a default browse or query." },
  connections: { category: "database-safety", label: "Connections", description: "Manage connections and write access in the Database workbench." },
  "desktop-notifications": { category: "notifications", label: "Desktop notifications", description: "Shows whether desktop notifications are supported in this environment. Permission controls arrive with notification events." },
  "local-storage": { category: "data-privacy", label: "Local settings storage", description: "UI preferences stay in local browser storage; operational settings live in your NoMoreIDE config directory." },
  "export-reset": { category: "data-privacy", label: "Export and reset", description: "Export and reset controls are coming in a later delivery." },
  version: { category: "about", label: "Version", description: "Application version." },
  console: { category: "about", label: "Console", description: "Local runtime address." },
  documentation: { category: "about", label: "Documentation", description: "NoMoreIDE documentation and support." },
} as const satisfies Record<string, { category: SettingsCategoryId; label: string; description: string }>;

export type SettingId = keyof typeof SETTING_COPY;

export function settingCopy(id: SettingId | string): (typeof SETTING_COPY)[SettingId] {
  const copy = SETTING_COPY[id as SettingId];
  if (!copy) throw new Error(`Missing settings copy for "${id}".`);
  return copy;
}

// The English copy above stays the search corpus and fallback; display strings
// resolve through the i18n catalog by id-derived key.
export function settingLabelKey(id: SettingId): TranslationKey {
  return `settingsHub.item.${id}.label` as TranslationKey;
}

export function settingDescKey(id: SettingId): TranslationKey {
  return `settingsHub.item.${id}.desc` as TranslationKey;
}

export function categoryLabelKey(id: SettingsCategoryId): TranslationKey {
  return `settingsHub.cat.${id}.label` as TranslationKey;
}

export function categoryDescKey(id: SettingsCategoryId): TranslationKey {
  return `settingsHub.cat.${id}.desc` as TranslationKey;
}

export const SEARCHABLE_SETTINGS = Object.keys(SETTING_COPY) as SettingId[];

export function matchingSettingIds(
  categoryId: SettingsCategoryId,
  query: string,
  translate?: (key: TranslationKey) => string,
): SettingId[] {
  const category = categoryById(categoryId);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return SEARCHABLE_SETTINGS.filter((id) => {
    const copy = settingCopy(id);
    if (copy.category !== categoryId) return false;
    // Search matches the English source copy plus, when a translator is
    // provided, the localized label/description the user actually sees.
    const localized = translate
      ? ` ${translate(categoryLabelKey(categoryId))} ${translate(settingLabelKey(id))} ${translate(settingDescKey(id))}`
      : "";
    const text =
      `${category.label} ${category.description} ${category.keywords.join(" ")} ${copy.label} ${copy.description}${localized}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}


export function categoryById(id: SettingsCategoryId): SettingsCategory {
  return SETTINGS_CATEGORIES.find((category) => category.id === id) ?? SETTINGS_CATEGORIES[0];
}
