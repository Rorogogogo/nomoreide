import { useMemo, useState, type ReactNode } from "react";
import { BookOpen, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LANGUAGE_OPTIONS, type Language } from "@/lib/language";
import { SETTINGS_CATEGORIES, SETTING_SEARCH_TEXT, categoryById, type SettingsCategoryId } from "./settings-catalogue";
import { ManagementRow, ScopeBadge, SettingNumberInput, SettingSelect, SettingToggle, UnavailableSetting } from "./setting-controls";
import { useSettings } from "./settings-context";
import { SettingsLayout } from "./settings-layout";

export interface SettingsViewProps {
  activeProject?: { name: string; path?: string } | null;
  onNavigate?: (page: "github" | "agent-env" | "database") => void;
}

function ScopeSection({ scope, title, children }: { scope: "global" | "project"; title?: string; children: ReactNode }) {
  return <section className="mb-4 overflow-hidden rounded-lg border border-border bg-background/70"><div className="flex items-center justify-between gap-3 border-b border-border bg-muted/25 px-4 py-2.5"><h3 className="text-xs font-semibold">{title ?? (scope === "global" ? "Global" : "Current project")}</h3><ScopeBadge scope={scope} /></div>{children}</section>;
}

function ProjectNotice({ project }: { project: SettingsViewProps["activeProject"] }) {
  return project ? <div className="border-b border-border/50 bg-amber-500/5 px-4 py-2 text-[11px] text-muted-foreground"><span className="font-medium text-foreground">{project.name}</span> · Changes are written to <code>nomoreide.config.json</code>.</div> : <div className="border-b border-border/50 bg-muted/30 px-4 py-2 text-xs text-muted-foreground">Select a project to change project settings.</div>;
}

export function SettingsView({ activeProject = null, onNavigate }: SettingsViewProps = {}) {
  const settings = useSettings();
  const [selected, setSelected] = useState<SettingsCategoryId>("general");
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const matches = (category: SettingsCategoryId, text: string) => {
    if (!query) return false;
    const meta = categoryById(category);
    const haystack = `${meta.label} ${meta.description} ${meta.keywords.join(" ")} ${text}`.toLowerCase();
    return query.split(/\s+/).every((word) => haystack.includes(word));
  };

  const searchMatches = useMemo(() => {
    if (!query) return [];
    return SETTINGS_CATEGORIES.filter((category) =>
      matches(category.id, SETTING_SEARCH_TEXT[category.id]),
    ).map((item) => item.id);
  }, [query]);

  let content: ReactNode;
  if (settings.loading) {
    content = <div aria-label="Loading settings" className="space-y-3" role="status">{[0, 1, 2].map((item) => <div className="h-20 animate-pulse rounded-lg border border-border bg-muted/40" key={item} />)}</div>;
  } else if (settings.loadError) {
    content = <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4"><p className="text-sm font-medium">Settings could not be loaded</p><p className="mt-1 text-xs text-destructive">{settings.loadError}</p><Button className="mt-3" onClick={() => void settings.retry()} size="sm" type="button" variant="outline">Retry</Button></div>;
  } else if (query) {
    content = <div><h2 className="mb-4 text-base font-semibold">Search results</h2>{searchMatches.length ? searchMatches.map((id) => <div className="mb-5" key={id}><div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{categoryById(id).label}</div><CategoryContent activeProject={activeProject} category={id} onNavigate={onNavigate} settings={settings} /></div>) : <UnavailableSetting>No settings match “{search.trim()}”.</UnavailableSetting>}</div>;
  } else {
    content = <CategoryContent activeProject={activeProject} category={selected} onNavigate={onNavigate} settings={settings} />;
  }

  return <SettingsLayout onSearch={setSearch} onSelect={setSelected} saveError={settings.saveError} saveState={settings.saveState} search={search} selected={selected}>{content}</SettingsLayout>;
}

type SettingsValue = ReturnType<typeof useSettings>;

function CategoryContent({ category, activeProject, onNavigate, settings }: { category: SettingsCategoryId; activeProject: SettingsViewProps["activeProject"]; onNavigate: SettingsViewProps["onNavigate"]; settings: SettingsValue }) {
  const projectDisabled = !activeProject;
  switch (category) {
    case "general": return <ScopeSection scope="global"><SettingSelect description="Choose the language preference for this console." id="setting-language" label="Language" onChange={(value) => settings.updateUi({ language: value as Language })} options={LANGUAGE_OPTIONS.map((item) => ({ value: item.value, label: item.nativeLabel, disabled: !item.available }))} value={settings.ui.language} /><SettingToggle checked={settings.ui.sidebarDocked} description="Keep the navigation expanded while you work." id="setting-sidebar-docked" label="Dock sidebar" onChange={(value) => settings.updateUi({ sidebarDocked: value })} /><SettingSelect description="Choose whether Run pages open across every project or the selected project." id="setting-project-scope" label="Default project scope" onChange={(value) => settings.updateUi({ projectScope: value as "all" | "project" })} options={[{ value: "all", label: "All projects" }, { value: "project", label: "Current project" }]} value={settings.ui.projectScope} /></ScopeSection>;
    case "appearance": return <ScopeSection scope="global"><SettingSelect description="Follow your system or choose an explicit dashboard theme." id="setting-theme" label="Theme" onChange={(value) => settings.updateUi({ theme: value as "system" | "light" | "dark" })} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} value={settings.ui.theme} /><SettingSelect description="Adjust spacing throughout the control surface." id="setting-density" label="Interface density" onChange={(value) => settings.updateUi({ density: value as "comfortable" | "compact" })} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} value={settings.ui.density} /><SettingNumberInput description="Size used by code and log surfaces." id="setting-code-font" label="Code font size" max={18} min={10} onSave={(value) => settings.updateUi({ codeFontSize: value })} value={settings.ui.codeFontSize} /><SettingToggle checked={settings.ui.reducedMotion} description="Reduce non-essential movement and animated transitions." id="setting-reduced-motion" label="Reduced motion" onChange={(value) => settings.updateUi({ reducedMotion: value })} /></ScopeSection>;
    case "terminal": return <ScopeSection scope="global"><SettingNumberInput description="Text size for terminal sessions." id="setting-terminal-font" label="Terminal font size" max={24} min={10} onSave={(value) => settings.updateGlobal({ terminal: { fontSize: value } })} value={settings.global.terminal.fontSize} /><SettingSelect description="Shape of the active terminal cursor." id="setting-cursor" label="Cursor style" onChange={(value) => void settings.updateGlobal({ terminal: { cursorStyle: value as "block" | "underline" | "bar" } })} options={[{ value: "block", label: "Block" }, { value: "underline", label: "Underline" }, { value: "bar", label: "Bar" }]} value={settings.global.terminal.cursorStyle} /><SettingNumberInput description="Number of previous terminal lines kept in memory." id="setting-scrollback" label="Scrollback limit" max={100000} min={500} onSave={(value) => settings.updateGlobal({ terminal: { scrollback: value } })} value={settings.global.terminal.scrollback} /><SettingToggle checked={settings.global.terminal.copyOnSelect} description="Copy selected terminal text to the clipboard." id="setting-copy-on-select" label="Copy on select" onChange={(value) => void settings.updateGlobal({ terminal: { copyOnSelect: value } })} /><SettingToggle checked={settings.global.terminal.confirmTerminate} description="Ask before closing, stopping, or restarting a running process. Danger confirmation." id="setting-confirm-terminate" label="Confirm before terminating" onChange={(value) => void settings.updateGlobal({ terminal: { confirmTerminate: value } })} /></ScopeSection>;
    case "services-logs": return <ScopeSection scope="project"><ProjectNotice project={activeProject} /><SettingToggle checked={settings.project.logs.showTimestamps} description="Show the time gutter beside each log entry." disabled={projectDisabled} id="setting-log-timestamps" label="Show timestamps" onChange={(value) => void settings.updateProject({ logs: { showTimestamps: value } })} /><SettingToggle checked={settings.project.logs.wrapLines} description="Wrap long output instead of scrolling horizontally." disabled={projectDisabled} id="setting-wrap-lines" label="Wrap log lines" onChange={(value) => void settings.updateProject({ logs: { wrapLines: value } })} /></ScopeSection>;
    case "git-github": return <><ScopeSection scope="global" title="Global"><ManagementRow action={<Button onClick={() => onNavigate?.("github")} size="sm" type="button" variant="outline">Manage GitHub</Button>} description="Review the current GitHub connection without exposing credentials here." title="GitHub connection" /></ScopeSection><ScopeSection scope="project" title="Current project"><ProjectNotice project={activeProject} /><ManagementRow description="Repository-specific Git preferences will appear when their behavior is available." title="Repository defaults" /></ScopeSection></>;
    case "agents-mcp": return <><ScopeSection scope="global" title="Global"><ManagementRow action={<Button onClick={() => onNavigate?.("agent-env")} size="sm" type="button" variant="outline">Open Agent Environments</Button>} description="Manage installed agents, MCP servers, skills, and profiles." title="Agent environments" /></ScopeSection><ScopeSection scope="project" title="Current project"><ProjectNotice project={activeProject} /><ManagementRow description="Project-specific agent configuration remains in Agent Environments." title="Project agent context" /></ScopeSection></>;
    case "database-safety": return <ScopeSection scope="project"><ProjectNotice project={activeProject} /><SettingToggle checked={settings.project.database.confirmWrites} description="Show a danger confirmation before write statements are submitted." disabled={projectDisabled} id="setting-confirm-writes" label="Confirm before writes" onChange={(value) => void settings.updateProject({ database: { confirmWrites: value } })} /><SettingNumberInput description="Maximum rows requested for a default browse or query." disabled={projectDisabled} id="setting-result-limit" label="Default result limit" max={5000} min={10} onSave={(value) => settings.updateProject({ database: { resultLimit: value } })} value={settings.project.database.resultLimit} /><ManagementRow action={<Button disabled={!activeProject} onClick={() => onNavigate?.("database")} size="sm" type="button" variant="outline">Open Database</Button>} description="Manage connections and write access in the Database workbench." title="Connections" /></ScopeSection>;
    case "notifications": return <ScopeSection scope="global"><ManagementRow description={typeof Notification === "undefined" ? "Desktop notifications are not supported in this environment." : `Browser permission: ${Notification.permission}. Permission controls arrive with notification events.`} title="Desktop notifications" /></ScopeSection>;
    case "data-privacy": return <><ScopeSection scope="global" title="Global"><ManagementRow description="UI preferences stay in local browser storage; operational settings live in your NoMoreIDE config directory." title="Local settings storage" /></ScopeSection><ScopeSection scope="project" title="Current project"><ProjectNotice project={activeProject} /><UnavailableSetting>Export and reset controls are coming in a later delivery.</UnavailableSetting></ScopeSection></>;
    case "about": return <ScopeSection scope="global"><div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 px-4 py-4 text-xs"><span className="text-muted-foreground">Version</span><code>v{__APP_VERSION__}</code><span className="text-muted-foreground">Console</span><code>127.0.0.1:4317</code><span className="text-muted-foreground">Documentation</span><a className="inline-flex items-center gap-1 text-primary hover:underline" href="https://www.nomoreide.com/docs" rel="noreferrer" target="_blank"><BookOpen className="size-3" />nomoreide.com/docs<ExternalLink className="size-3" /></a></div></ScopeSection>;
  }
}
