import { useMemo, useState, type ReactNode } from "react";
import { BookOpen, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LANGUAGE_OPTIONS, type Language } from "@/lib/language";
import {
  SETTINGS_CATEGORIES,
  categoryById,
  matchingSettingIds,
  settingCopy,
  type SettingId,
  type SettingsCategoryId,
} from "./settings-catalogue";
import {
  ManagementRow,
  ScopeBadge,
  SettingNumberInput,
  SettingSelect,
  SettingToggle,
  UnavailableSetting,
} from "./setting-controls";
import { useSettings } from "./settings-context";
import { SettingsLayout } from "./settings-layout";

export interface SettingsViewProps {
  activeProject?: { name: string; path?: string } | null;
  onNavigate?: (page: "github" | "agent-env" | "database") => void;
}

function ScopeSection({ scope, title, children }: {
  scope: "global" | "project";
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-4 overflow-hidden rounded-lg border border-border bg-background/70">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/25 px-4 py-2.5">
        <h3 className="text-xs font-semibold">
          {title ?? (scope === "global" ? "Global" : "Current project")}
        </h3>
        <ScopeBadge scope={scope} />
      </div>
      {children}
    </section>
  );
}

function ProjectNotice({ project, ready, loadError, onRetry }: {
  project: SettingsViewProps["activeProject"];
  ready: boolean;
  loadError: string | null;
  onRetry: () => void;
}) {
  if (project && loadError) {
    return (
      <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-3" role="alert">
        <p className="text-xs text-destructive">{loadError}</p>
        <Button aria-label="Retry project settings" className="mt-2" onClick={onRetry} size="sm" type="button" variant="outline">
          Retry project settings
        </Button>
      </div>
    );
  }
  if (project && !ready) {
    return (
      <div className="border-b border-border/50 bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
        Loading settings for {project.name}…
      </div>
    );
  }
  return project ? (
    <div className="border-b border-border/50 bg-amber-500/5 px-4 py-2 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">{project.name}</span>
      {" · Changes are written to "}<code>nomoreide.config.json</code>.
    </div>
  ) : (
    <div className="border-b border-border/50 bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
      Select a project to change project settings.
    </div>
  );
}

export function SettingsView({ activeProject = null, onNavigate }: SettingsViewProps = {}) {
  const settings = useSettings();
  const projectReady = Boolean(
    activeProject?.path &&
    activeProject.path === settings.activeProjectPath &&
    !settings.projectLoading &&
    !settings.projectLoadError,
  );
  const [selected, setSelected] = useState<SettingsCategoryId>("general");
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const searchMatches = useMemo(() => {
    if (!query) return [];
    return SETTINGS_CATEGORIES.map((category) => ({
      id: category.id,
      settingIds: matchingSettingIds(category.id, query),
    })).filter((match) => match.settingIds.length > 0);
  }, [query]);

  let content: ReactNode;
  if (settings.loading) {
    content = (
      <div aria-label="Loading settings" className="space-y-3" role="status">
        {[0, 1, 2].map((item) => (
          <div className="h-20 animate-pulse rounded-lg border border-border bg-muted/40" key={item} />
        ))}
      </div>
    );
  } else if (settings.loadError) {
    content = (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4" role="alert">
        <p className="text-sm font-medium">Settings could not be loaded</p>
        <p className="mt-1 text-xs text-destructive">{settings.loadError}</p>
        <Button className="mt-3" onClick={() => void settings.retry()} size="sm" type="button" variant="outline">
          Retry
        </Button>
      </div>
    );
  } else if (query) {
    content = (
      <div>
        <h2 className="mb-4 text-base font-semibold">Search results</h2>
        {searchMatches.length ? searchMatches.map(({ id, settingIds }) => (
          <div className="mb-5" key={id}>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {categoryById(id).label}
            </div>
            <CategoryContent
              activeProject={activeProject}
              category={id}
              onNavigate={onNavigate}
              projectReady={projectReady}
              settings={settings}
              visibleSettingIds={new Set(settingIds)}
            />
          </div>
        )) : <UnavailableSetting>No settings match “{search.trim()}”.</UnavailableSetting>}
      </div>
    );
  } else {
    content = (
      <CategoryContent
        activeProject={activeProject}
        category={selected}
        onNavigate={onNavigate}
        projectReady={projectReady}
        settings={settings}
      />
    );
  }

  return (
    <SettingsLayout
      onSearch={setSearch}
      onSelect={setSelected}
      saveError={settings.saveError}
      saveState={settings.saveState}
      search={search}
      selected={selected}
    >
      {content}
    </SettingsLayout>
  );
}

type SettingsValue = ReturnType<typeof useSettings>;

function CategoryContent({
  category,
  activeProject,
  projectReady,
  onNavigate,
  settings,
  visibleSettingIds,
}: {
  category: SettingsCategoryId;
  activeProject: SettingsViewProps["activeProject"];
  projectReady: boolean;
  onNavigate: SettingsViewProps["onNavigate"];
  settings: SettingsValue;
  visibleSettingIds?: ReadonlySet<SettingId>;
}) {
  const projectDisabled = !projectReady;
  const visible = (id: SettingId) => !visibleSettingIds || visibleSettingIds.has(id);
  const anyVisible = (ids: SettingId[]) => ids.some(visible);
  const copy = (id: SettingId) => {
    const { label, description } = settingCopy(id);
    return { label, description };
  };

  switch (category) {
    case "general":
      return (
        <ScopeSection scope="global">
          {visible("language") ? <SettingSelect {...copy("language")} id="setting-language" onChange={(value) => settings.updateUi({ language: value as Language })} options={LANGUAGE_OPTIONS.map((item) => ({ value: item.value, label: item.nativeLabel, disabled: !item.available }))} value={settings.ui.language} /> : null}
          {visible("sidebar-docked") ? <SettingToggle {...copy("sidebar-docked")} checked={settings.ui.sidebarDocked} id="setting-sidebar-docked" onChange={(value) => settings.updateUi({ sidebarDocked: value })} /> : null}
          {visible("project-scope") ? <SettingSelect {...copy("project-scope")} id="setting-project-scope" onChange={(value) => settings.updateUi({ projectScope: value as "all" | "project" })} options={[{ value: "all", label: "All projects" }, { value: "project", label: "Current project" }]} value={settings.ui.projectScope} /> : null}
        </ScopeSection>
      );
    case "appearance":
      return (
        <ScopeSection scope="global">
          {visible("theme") ? <SettingSelect {...copy("theme")} id="setting-theme" onChange={(value) => settings.updateUi({ theme: value as "system" | "light" | "dark" })} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} value={settings.ui.theme} /> : null}
          {visible("density") ? <SettingSelect {...copy("density")} id="setting-density" onChange={(value) => settings.updateUi({ density: value as "comfortable" | "compact" })} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} value={settings.ui.density} /> : null}
          {visible("code-font") ? <SettingNumberInput {...copy("code-font")} id="setting-code-font" max={18} min={10} onSave={(value) => {
                settings.updateUi({ codeFontSize: value });
              }} value={settings.ui.codeFontSize} /> : null}
          {visible("reduced-motion") ? <SettingToggle {...copy("reduced-motion")} checked={settings.ui.reducedMotion} id="setting-reduced-motion" onChange={(value) => settings.updateUi({ reducedMotion: value })} /> : null}
        </ScopeSection>
      );
    case "terminal":
      return (
        <ScopeSection scope="global">
          {visible("terminal-font") ? <SettingNumberInput {...copy("terminal-font")} id="setting-terminal-font" max={24} min={10} onSave={(value) => settings.updateGlobal({ terminal: { fontSize: value } })} value={settings.global.terminal.fontSize} /> : null}
          {visible("cursor") ? <SettingSelect {...copy("cursor")} id="setting-cursor" onChange={(value) => void settings.updateGlobal({ terminal: { cursorStyle: value as "block" | "underline" | "bar" } })} options={[{ value: "block", label: "Block" }, { value: "underline", label: "Underline" }, { value: "bar", label: "Bar" }]} value={settings.global.terminal.cursorStyle} /> : null}
          {visible("scrollback") ? <SettingNumberInput {...copy("scrollback")} id="setting-scrollback" max={100000} min={500} onSave={(value) => settings.updateGlobal({ terminal: { scrollback: value } })} value={settings.global.terminal.scrollback} /> : null}
          {visible("copy-on-select") ? <SettingToggle {...copy("copy-on-select")} checked={settings.global.terminal.copyOnSelect} id="setting-copy-on-select" onChange={(value) => void settings.updateGlobal({ terminal: { copyOnSelect: value } })} /> : null}
          {visible("confirm-terminate") ? <SettingToggle {...copy("confirm-terminate")} checked={settings.global.terminal.confirmTerminate} id="setting-confirm-terminate" onChange={(value) => void settings.updateGlobal({ terminal: { confirmTerminate: value } })} /> : null}
        </ScopeSection>
      );
    case "services-logs":
      return (
        <ScopeSection scope="project">
          <ProjectNotice loadError={settings.projectLoadError} onRetry={() => void settings.retryProject()} project={activeProject} ready={projectReady} />
          {visible("log-timestamps") ? <SettingToggle {...copy("log-timestamps")} checked={settings.project.logs.showTimestamps} disabled={projectDisabled} id="setting-log-timestamps" onChange={(value) => void settings.updateProject({ logs: { showTimestamps: value } })} /> : null}
          {visible("wrap-lines") ? <SettingToggle {...copy("wrap-lines")} checked={settings.project.logs.wrapLines} disabled={projectDisabled} id="setting-wrap-lines" onChange={(value) => void settings.updateProject({ logs: { wrapLines: value } })} /> : null}
        </ScopeSection>
      );
    case "git-github":
      return (
        <>
          {anyVisible(["github-connection"]) ? (
            <ScopeSection scope="global" title="Global">
              <ManagementRow
                action={<Button onClick={() => onNavigate?.("github")} size="sm" type="button" variant="outline">Manage GitHub</Button>}
                description={copy("github-connection").description}
                title={copy("github-connection").label}
              />
            </ScopeSection>
          ) : null}
          {anyVisible(["repository-defaults"]) ? (
            <ScopeSection scope="project" title="Current project">
              <ProjectNotice loadError={settings.projectLoadError} onRetry={() => void settings.retryProject()} project={activeProject} ready={projectReady} />
              <ManagementRow
                description={copy("repository-defaults").description}
                title={copy("repository-defaults").label}
              />
            </ScopeSection>
          ) : null}
        </>
      );
    case "agents-mcp":
      return (
        <>
          {anyVisible(["agent-environments"]) ? (
            <ScopeSection scope="global" title="Global">
              <ManagementRow
                action={<Button onClick={() => onNavigate?.("agent-env")} size="sm" type="button" variant="outline">Open Agent Environments</Button>}
                description={copy("agent-environments").description}
                title={copy("agent-environments").label}
              />
            </ScopeSection>
          ) : null}
          {anyVisible(["project-agent-context"]) ? (
            <ScopeSection scope="project" title="Current project">
              <ProjectNotice loadError={settings.projectLoadError} onRetry={() => void settings.retryProject()} project={activeProject} ready={projectReady} />
              <ManagementRow
                description={copy("project-agent-context").description}
                title={copy("project-agent-context").label}
              />
            </ScopeSection>
          ) : null}
        </>
      );
    case "database-safety":
      return (
        <ScopeSection scope="project">
          <ProjectNotice loadError={settings.projectLoadError} onRetry={() => void settings.retryProject()} project={activeProject} ready={projectReady} />
          {visible("confirm-writes") ? <SettingToggle {...copy("confirm-writes")} checked={settings.project.database.confirmWrites} disabled={projectDisabled} id="setting-confirm-writes" onChange={(value) => void settings.updateProject({ database: { confirmWrites: value } })} /> : null}
          {visible("result-limit") ? <SettingNumberInput {...copy("result-limit")} disabled={projectDisabled} id="setting-result-limit" max={5000} min={10} onSave={(value) => settings.updateProject({ database: { resultLimit: value } })} scopeKey={settings.activeProjectPath} value={settings.project.database.resultLimit} /> : null}
          {visible("connections") ? (
            <ManagementRow
              action={<Button disabled={projectDisabled} onClick={() => onNavigate?.("database")} size="sm" type="button" variant="outline">Open Database</Button>}
              description={copy("connections").description}
              title={copy("connections").label}
            />
          ) : null}
        </ScopeSection>
      );
    case "notifications": {
      const permission = typeof Notification === "undefined"
        ? "Unavailable in this runtime"
        : `Permission: ${Notification.permission}`;
      return (
        <ScopeSection scope="global">
          {visible("desktop-notifications") ? (
            <ManagementRow
              action={<span className="font-mono text-xs text-muted-foreground">{permission}</span>}
              description={copy("desktop-notifications").description}
              title={copy("desktop-notifications").label}
            />
          ) : null}
        </ScopeSection>
      );
    }
    case "data-privacy":
      return (
        <>
          {anyVisible(["local-storage"]) ? (
            <ScopeSection scope="global" title="Global">
              <ManagementRow
                description={copy("local-storage").description}
                title={copy("local-storage").label}
              />
            </ScopeSection>
          ) : null}
          {anyVisible(["export-reset"]) ? (
            <ScopeSection scope="project" title="Current project">
              <ProjectNotice loadError={settings.projectLoadError} onRetry={() => void settings.retryProject()} project={activeProject} ready={projectReady} />
              <ManagementRow
                description={copy("export-reset").description}
                title={copy("export-reset").label}
              />
            </ScopeSection>
          ) : null}
        </>
      );
    case "about":
      return (
        <ScopeSection scope="global">
          <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 px-4 py-4 text-xs">
            {visible("version") ? <><span className="text-muted-foreground">{copy("version").label}</span><code>v{__APP_VERSION__}</code></> : null}
            {visible("console") ? <><span className="text-muted-foreground">{copy("console").label}</span><code>127.0.0.1:4317</code></> : null}
            {visible("documentation") ? <><span className="text-muted-foreground">{copy("documentation").label}</span><a className="inline-flex items-center gap-1 text-primary hover:underline" href="https://www.nomoreide.com/docs" rel="noreferrer" target="_blank"><BookOpen className="size-3" />nomoreide.com/docs<ExternalLink className="size-3" /></a></> : null}
          </div>
        </ScopeSection>
      );
  }
}
