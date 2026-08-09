import { APP_NAV_ITEMS, type AppPage } from "@/components/app-navigation";
import type { DashboardData } from "@/lib/api";
import type { TranslationKey } from "@/lib/i18n";
import type { AgentTerminalTask } from "@/features/agent/terminal/use-agent-terminal-tasks";
import {
  SEARCHABLE_SETTINGS,
  SETTINGS_CATEGORIES,
  categoryLabelKey,
  settingCopy,
  settingDescKey,
  settingLabelKey,
  type SettingId,
  type SettingsCategoryId,
} from "@/features/settings/settings-catalogue";

export const GLOBAL_SEARCH_KIND_META = {
  page: { labelKey: "globalSearch.group.pages" },
  setting: { labelKey: "globalSearch.group.settings" },
  project: { labelKey: "globalSearch.group.projects" },
  service: { labelKey: "globalSearch.group.services" },
  bundle: { labelKey: "globalSearch.group.bundles" },
  branch: { labelKey: "globalSearch.group.branches" },
  file: { labelKey: "globalSearch.group.files" },
  "agent-task": { labelKey: "globalSearch.group.tasks" },
} as const satisfies Record<string, { labelKey: TranslationKey }>;

export type GlobalSearchKind = keyof typeof GLOBAL_SEARCH_KIND_META;
export const GLOBAL_SEARCH_KINDS = Object.keys(GLOBAL_SEARCH_KIND_META) as GlobalSearchKind[];

export type GlobalSearchTarget =
  | { type: "page"; page: AppPage }
  | { type: "setting"; category: SettingsCategoryId; setting: SettingId }
  | { type: "project"; name: string }
  | { type: "service"; name: string }
  | { type: "bundle"; name: string; firstService?: string }
  | { type: "branch"; name: string }
  | { type: "file"; path: string }
  | { type: "agent-task"; id: string };

export interface GlobalSearchItem {
  id: string;
  kind: GlobalSearchKind;
  label: string;
  detail?: string;
  keywords: readonly string[];
  target: GlobalSearchTarget;
}

interface BuildGlobalSearchItemsInput {
  data: DashboardData | null;
  tasks: readonly AgentTerminalTask[];
  translate: (key: TranslationKey) => string;
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .trim();
}

export function buildGlobalSearchItems({
  data,
  tasks,
  translate,
}: BuildGlobalSearchItemsInput): GlobalSearchItem[] {
  const pages: GlobalSearchItem[] = [
    ...APP_NAV_ITEMS.map((item) => ({
      id: `page:${item.page}`,
      kind: "page" as const,
      label: translate(item.labelKey),
      keywords: [item.page, "page", "navigation"],
      target: { type: "page" as const, page: item.page },
    })),
    {
      id: "page:settings",
      kind: "page",
      label: translate("nav.settings"),
      keywords: ["settings", "preferences", "configuration"],
      target: { type: "page", page: "settings" },
    },
  ];

  const settings: GlobalSearchItem[] = SEARCHABLE_SETTINGS.map((setting) => {
    const copy = settingCopy(setting);
    const category = SETTINGS_CATEGORIES.find((entry) => entry.id === copy.category);
    return {
      id: `setting:${setting}`,
      kind: "setting",
      label: translate(settingLabelKey(setting)),
      detail: translate(categoryLabelKey(copy.category)),
      keywords: [
        copy.label,
        copy.description,
        translate(settingDescKey(setting)),
        ...(category?.keywords ?? []),
      ],
      target: { type: "setting", category: copy.category, setting },
    };
  });

  const agentTasks: GlobalSearchItem[] = tasks
    .filter((task) => task.kind === "agent" && (task.state === "idle" || task.state === "running"))
    .map((task) => ({
      id: `agent-task:${task.id}`,
      kind: "agent-task",
      label: task.label ?? `${task.provider ?? translate("globalSearch.agentFallback")} ${translate("globalSearch.taskFallback")}`,
      detail: task.cwd,
      keywords: [task.id, task.provider ?? "", task.state, task.source?.label ?? ""],
      target: { type: "agent-task", id: task.id },
    }));

  if (!data) return [...pages, ...settings, ...agentTasks];

  const projects: GlobalSearchItem[] = data.config.gitRepositories.map((project) => ({
    id: `project:${project.name}`,
    kind: "project",
    label: project.name,
    detail: project.activeWorktreePath ?? project.path,
    keywords: [project.path, project.activeWorktreePath ?? "", "repository", "repo"],
    target: { type: "project", name: project.name },
  }));
  const services: GlobalSearchItem[] = data.config.services.map((service) => ({
    id: `service:${service.name}`,
    kind: "service",
    label: service.name,
    detail: service.description ?? service.cwd ?? service.host,
    keywords: [
      service.kind ?? "local",
      service.cwd ?? "",
      service.host ?? "",
      service.port ? String(service.port) : "",
      service.description ?? "",
    ],
    target: { type: "service", name: service.name },
  }));
  const bundles: GlobalSearchItem[] = data.config.bundles.map((bundle) => ({
    id: `bundle:${bundle.name}`,
    kind: "bundle",
    label: bundle.name,
    detail: bundle.services.join(", "),
    keywords: ["bundle", ...bundle.services],
    target: {
      type: "bundle",
      name: bundle.name,
      firstService: bundle.services[0],
    },
  }));
  const branches: GlobalSearchItem[] = data.git.branches.map((branch) => ({
    id: `branch:${branch.name}`,
    kind: "branch",
    label: branch.name,
    detail: translate(
      branch.current
        ? "globalSearch.branchCurrent"
        : branch.remote
          ? "globalSearch.branchRemote"
          : "globalSearch.branchLocal",
    ),
    keywords: [branch.upstream ?? "", branch.current ? "current" : "", branch.remote ? "remote" : "local"],
    target: { type: "branch", name: branch.name },
  }));
  const files: GlobalSearchItem[] = (data.git.status?.files ?? []).map((file) => ({
    id: `file:${file.path}`,
    kind: "file",
    label: file.path.split("/").at(-1) ?? file.path,
    detail: file.path,
    keywords: [file.path, file.index, file.workingTree, "changed", "modified"],
    target: { type: "file", path: file.path },
  }));
  return [
    ...pages,
    ...settings,
    ...projects,
    ...services,
    ...bundles,
    ...branches,
    ...files,
    ...agentTasks,
  ];
}

export function searchGlobalItems(
  items: readonly GlobalSearchItem[],
  query: string,
  limit = 50,
): GlobalSearchItem[] {
  const normalized = normalize(query);
  if (!normalized) return items.filter((item) => item.kind === "page").slice(0, limit);
  const words = normalized.split(/\s+/).filter(Boolean);

  return items
    .map((item, index) => {
      const label = normalize(item.label);
      const detail = normalize(item.detail ?? "");
      const keywords = normalize(item.keywords.join(" "));
      const text = `${label} ${detail} ${keywords}`;
      if (!words.every((word) => text.includes(word))) return null;

      const score = label === normalized
        ? 0
        : label.startsWith(normalized)
          ? 1
          : words.every((word) => label.split(/\s+/).some((part) => part.startsWith(word)))
            ? 2
            : label.includes(normalized)
              ? 3
              : detail.includes(normalized)
                ? 4
                : 5;
      return { item, index, score };
    })
    .filter((entry): entry is { item: GlobalSearchItem; index: number; score: number } => Boolean(entry))
    .sort((left, right) =>
      left.score - right.score ||
      GLOBAL_SEARCH_KINDS.indexOf(left.item.kind) - GLOBAL_SEARCH_KINDS.indexOf(right.item.kind) ||
      left.item.label.localeCompare(right.item.label) ||
      left.index - right.index,
    )
    .slice(0, limit)
    .map((entry) => entry.item);
}
