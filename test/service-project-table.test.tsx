// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceProjectTable } from "../apps/dashboard/src/features/services/service-project-table";
import type { DashboardData } from "../apps/dashboard/src/lib/api";

const api = vi.hoisted(() => ({ setServiceProject: vi.fn() }));

vi.mock("@/lib/api", () => ({ setServiceProject: api.setServiceProject }));

vi.mock("@/components/ui/toast", () => ({
  useToasts: () => ({ error: vi.fn(), success: vi.fn() }),
}));

const REPOS = [
  { name: "acme", path: "/repos/acme" },
  { name: "beta", path: "/repos/beta" },
];

function dashboard(services: Record<string, unknown>[]): DashboardData {
  return { config: { services, gitRepositories: REPOS } } as unknown as DashboardData;
}

let container: HTMLDivElement;
let root: Root;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  api.setServiceProject.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(services: Record<string, unknown>[]) {
  act(() => {
    root.render(<ServiceProjectTable data={dashboard(services)} onRefresh={async () => {}} />);
  });
}

const selects = () => [...container.querySelectorAll("select")];

describe("ServiceProjectTable", () => {
  test("shows an inferred row as unpinned and names what it resolved to", () => {
    render([{ name: "api", cwd: "/repos/acme/server" }]);

    const [select] = selects();
    expect(select.value).toBe("");
    expect(select.options[0].textContent).toContain("acme");
    expect(container.textContent).toContain("inferred");
  });

  test("shows a pinned row selected on its project", () => {
    render([{ name: "logs", cwd: "/var/www/app", projectPath: "/repos/beta" }]);

    expect(selects()[0].value).toBe("/repos/beta");
    expect(container.textContent).toContain("pinned");
  });

  test("names the fallback a pinned row would drop to, not its current project", () => {
    // The default option must describe clearing the pin, so choosing it is not
    // a guess — here cwd sits under acme while the pin points at beta.
    render([{ name: "api", cwd: "/repos/acme/server", projectPath: "/repos/beta" }]);

    expect(selects()[0].options[0].textContent).toContain("acme");
  });

  test("keeps a pin whose project no longer exists visible and selected", () => {
    render([{ name: "orphan", cwd: "/var/www/app", projectPath: "/repos/deleted" }]);

    const [select] = selects();
    expect(select.value).toBe("/repos/deleted");
    expect(select.textContent).toContain("/repos/deleted");
  });

  test("counts services that belong to no project", () => {
    render([
      { name: "api", cwd: "/repos/acme" },
      { name: "stray", cwd: "/elsewhere" },
    ]);

    expect(container.textContent).toContain("2 services · 1 unassigned");
  });

  test("omits the unassigned count when every service is placed", () => {
    render([{ name: "api", cwd: "/repos/acme" }]);

    expect(container.textContent).toContain("1 services");
    expect(container.textContent).not.toContain("unassigned");
  });

  test("saves a chosen project", () => {
    render([{ name: "stray", cwd: "/elsewhere" }]);

    const [select] = selects();
    act(() => {
      select.value = "/repos/beta";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(api.setServiceProject).toHaveBeenCalledWith("stray", "/repos/beta");
  });

  test("clears a pin as undefined rather than an empty string", () => {
    render([{ name: "logs", cwd: "/repos/acme", projectPath: "/repos/beta" }]);

    const [select] = selects();
    act(() => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(api.setServiceProject).toHaveBeenCalledWith("logs", undefined);
  });
});
