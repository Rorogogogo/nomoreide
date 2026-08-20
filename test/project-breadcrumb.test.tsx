// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProjectBreadcrumb } from "../apps/dashboard/src/features/git/project-breadcrumb";
import type { DashboardData } from "../apps/dashboard/src/lib/api";

vi.mock("@/components/ui/toast", () => ({
  useToasts: () => ({ error: vi.fn(), success: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({ selectGitRepository: vi.fn() }));

// The manage dialog pulls in the whole git API surface; the breadcrumb's own
// behaviour is what is under test here.
vi.mock("../apps/dashboard/src/features/git/project-switcher", () => ({
  ProjectSwitcherDialog: () => null,
}));

const REPOSITORIES = [
  "brainctl",
  "brainctl-platform",
  "nomoreide",
  "JobJourney",
  "laimio-amazon-ads-ppc-dashboard",
  "Notchy",
  "Levelline",
  "laimio-listing-optimization-os",
  "pawfectbite",
  "quest30",
];

function dashboard(names: string[]): DashboardData {
  return {
    config: { gitRepositories: names.map((name) => ({ name, path: `/repos/${name}` })) },
    git: { selectedRepository: { name: "JobJourney", path: "/repos/JobJourney" }, status: { branch: "main" } },
  } as unknown as DashboardData;
}

let container: HTMLDivElement;
let root: Root;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function openMenu(names: string[]) {
  act(() => {
    root.render(
      <ProjectBreadcrumb
        data={dashboard(names)}
        onRefresh={async () => {}}
        onScopeChange={() => {}}
        scopeAll={false}
      />,
    );
  });
  const trigger = container.querySelector("button");
  act(() => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const menu = document.querySelector('[role="menu"]');
  if (!menu) throw new Error("menu did not open");
  return menu;
}

function findRow(menu: Element, text: string) {
  return [...menu.querySelectorAll('[role="menuitem"]')].find((row) =>
    row.textContent?.includes(text),
  );
}

describe("ProjectBreadcrumb menu", () => {
  test("keeps add-or-manage outside the scrolling project list", () => {
    // Regression: with the action inside the scroll area, ten registered
    // projects pushed it past the menu's max height and the only way to add a
    // project became invisible.
    const menu = openMenu(REPOSITORIES);

    const scroller = menu.querySelector(".overflow-y-auto");
    const addRow = findRow(menu, "Add or manage projects");

    expect(scroller).toBeTruthy();
    expect(addRow).toBeTruthy();
    expect(scroller?.contains(addRow!)).toBe(false);
  });

  test("scrolls the projects themselves", () => {
    const menu = openMenu(REPOSITORIES);
    const scroller = menu.querySelector(".overflow-y-auto");

    for (const name of REPOSITORIES) {
      expect(scroller?.textContent).toContain(name);
    }
    expect(scroller?.textContent).toContain("All projects");
  });

  test("stays open while its own project list is scrolled", () => {
    // Regression: the capture-phase scroll listener that keeps the menu from
    // stranding on a page scroll also fired for the list's own scrolling, so
    // reaching a project past the fold dismissed the menu instead.
    const menu = openMenu(REPOSITORIES);
    const scroller = menu.querySelector(".overflow-y-auto");

    act(() => {
      scroller?.dispatchEvent(new Event("scroll", { bubbles: false }));
    });

    expect(document.querySelector('[role="menu"]')).toBeTruthy();
  });

  test("closes when the page behind it scrolls", () => {
    openMenu(REPOSITORIES);

    act(() => {
      document.body.dispatchEvent(new Event("scroll", { bubbles: false }));
    });

    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  test("offers add-or-manage when no project is registered yet", () => {
    const menu = openMenu([]);

    expect(findRow(menu, "Add or manage projects")).toBeTruthy();
  });

  test("caps its own height so the pinned action stays on screen", () => {
    const menu = openMenu(REPOSITORIES);

    expect(menu.className).toContain("max-h-80");
    expect(menu.className).toContain("flex-col");
  });
});
