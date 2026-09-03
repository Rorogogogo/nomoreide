// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProjectOverviewTable } from "../apps/dashboard/src/features/overview/project-overview-table";
import { DOMAIN_TEMPLATES } from "../apps/dashboard/src/features/overview/project-overview-columns";

const api = vi.hoisted(() => ({
  listProjectOverview: vi.fn(),
  selectGitRepository: vi.fn(),
}));

vi.mock("@/lib/api", () => api);
vi.mock("@/components/ui/toast", () => ({
  useToasts: () => ({ error: vi.fn() }),
}));

const hosts: HTMLDivElement[] = [];

afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
  vi.clearAllMocks();
});

describe("all-project overview alignment", () => {
  test("keeps unavailable GitHub projects in the same project grid", async () => {
    api.listProjectOverview.mockResolvedValue([
      { name: "alpha", path: "/repos/alpha", error: "GitHub unavailable" },
      { name: "beta", path: "/repos/beta", error: "GitHub unavailable" },
    ]);
    const host = document.createElement("div");
    hosts.push(host);
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<ProjectOverviewTable domain="github" onEnterProject={() => {}} />);
    });

    expect(host.textContent).toContain("Repository");
    expect(host.textContent).toContain("Pull requests");
    for (const name of ["alpha", "beta"]) {
      const row = [...host.querySelectorAll("button")].find((button) =>
        button.textContent?.includes(name),
      );
      expect(row?.className).toContain(DOMAIN_TEMPLATES.github);
      expect(row?.querySelector(".col-span-3")).not.toBeNull();
    }

    act(() => root.unmount());
  });
});
