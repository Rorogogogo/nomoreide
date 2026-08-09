import { describe, expect, test } from "vitest";
import type { DashboardData } from "../src/web/client/src/lib/api/services-api";
import type { AgentTerminalTask } from "../src/web/client/src/features/agent/terminal/use-agent-terminal-tasks";
import {
  buildGlobalSearchItems,
  searchGlobalItems,
} from "../src/web/client/src/features/global-search/global-search-model";
import { en } from "../src/web/client/src/lib/i18n/en";
import { zh } from "../src/web/client/src/lib/i18n/zh";

const t = (key: keyof typeof en) => en[key];

const data = {
  ok: true,
  cwd: "/work/acme",
  config: {
    services: [{ name: "api", kind: "local", cwd: "/work/acme/api", description: "Customer API" }],
    bundles: [{ name: "development", services: ["api"] }],
    gitRepositories: [{ name: "acme", path: "/work/acme" }],
  },
  runtime: { services: {} },
  ports: [],
  health: {},
  timeline: [],
  logs: [],
  git: {
    cwd: "/work/acme",
    selectedRepository: { name: "acme", path: "/work/acme" },
    status: {
      branch: "main",
      ahead: 0,
      behind: 0,
      files: [{ path: "src/customer-api.ts", index: " ", workingTree: "M" }],
    },
    branches: [
      { name: "main", current: true, remote: false },
      { name: "feature/search", current: false, remote: false },
    ],
  },
} satisfies DashboardData;

const tasks = [
  {
    id: "task-1",
    cwd: "/work/acme",
    cols: 80,
    rows: 24,
    shell: "zsh",
    state: "running",
    kind: "agent",
    provider: "codex",
    label: "Implement search",
  },
  {
    id: "task-2",
    cwd: "/work/acme",
    cols: 80,
    rows: 24,
    shell: "zsh",
    state: "exited",
    kind: "agent",
    provider: "claude",
    label: "Old task",
  },
] satisfies AgentTerminalTask[];

describe("global search model", () => {
  const items = buildGlobalSearchItems({ data, tasks, translate: t });

  test("indexes every approved local result kind", () => {
    expect(new Set(items.map((item) => item.kind))).toEqual(new Set([
      "page",
      "setting",
      "project",
      "service",
      "bundle",
      "branch",
      "file",
      "agent-task",
    ]));
    expect(items.some((item) => item.id === "page:settings")).toBe(true);
    expect(items.some((item) => item.id === "agent-task:task-1")).toBe(true);
    expect(items.some((item) => item.id === "agent-task:task-2")).toBe(false);
  });

  test("matches multiple normalized tokens across labels and metadata", () => {
    expect(searchGlobalItems(items, "CUSTOMER api").map((item) => item.id)).toContain("service:api");
    expect(searchGlobalItems(items, "feature search").map((item) => item.id)).toContain("branch:feature/search");
    expect(searchGlobalItems(items, "customer api ts").map((item) => item.id)).toContain("file:src/customer-api.ts");
  });

  test("ranks exact labels before metadata matches and limits output", () => {
    const result = searchGlobalItems(items, "api", 2);
    expect(result[0]?.id).toBe("service:api");
    expect(result).toHaveLength(2);
  });

  test("shows navigation only until the user types", () => {
    expect(searchGlobalItems(items, "").every((item) => item.kind === "page")).toBe(true);
  });

  test("localizes visible fallback task and branch details", () => {
    const localized = buildGlobalSearchItems({
      data,
      tasks: [{ ...tasks[0], label: undefined }],
      translate: (key) => zh[key as keyof typeof zh] ?? en[key],
    });
    expect(localized.find((item) => item.id === "branch:main")?.detail).toBe("当前分支");
    expect(localized.find((item) => item.id === "agent-task:task-1")?.label).toBe("codex 任务");
  });
});
