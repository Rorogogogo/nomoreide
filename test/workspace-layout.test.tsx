// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { closeTab, mergePanes, openTab, parseLayout, singlePane, useWorkspaceLayout, type WorkspaceTab } from "@/features/workspace/workspace-layout";
import { WorkspaceView } from "@/features/workspace/workspace-view";

const services: WorkspaceTab = { page: "services", extensionId: null };
const github: WorkspaceTab = { page: "github", extensionId: null };
const docker: WorkspaceTab = { page: "docker", extensionId: null };
const containers: HTMLElement[] = [];
afterEach(() => { for (const container of containers.splice(0)) container.remove(); localStorage.clear(); });

describe("workspace layout", () => {
  test("opens side by side and focuses existing tabs without duplicating views", () => {
    const split = openTab(singlePane(services), github, 1);
    expect(split.panes.map((pane) => pane.tabs)).toEqual([[services], [github]]);
    expect(openTab(split, services)).toEqual({ ...split, focused: 0 });
  });
  test("closing tabs preserves the selection and collapses an empty pane", () => {
    let layout = openTab(openTab(singlePane(services), github), docker);
    layout = closeTab(layout, 0, 0);
    expect(layout.panes[0].tabs[layout.panes[0].active]).toEqual(docker);
    const split = openTab(singlePane(services), github, 1);
    expect(closeTab(split, 0, 0).panes).toEqual([{ id: "secondary", tabs: [github], active: 0 }]);
    expect(closeTab(singlePane(services), 0, 0)).toEqual(singlePane(services));
  });
  test("merging keeps every tab and the focused destination", () => {
    const merged = mergePanes(openTab(singlePane(services), github, 1));
    expect(merged.panes).toEqual([{ id: "primary", tabs: [services, github], active: 1 }]);
  });
  test("validates persisted state and clamps pane widths", () => {
    expect(parseLayout("invalid")).toBeNull();
    expect(parseLayout(JSON.stringify({ ...singlePane(services), focused: 4 }))).toBeNull();
    expect(parseLayout(JSON.stringify({ ...singlePane(services), panes: [{ id: "primary", tabs: [services, services], active: 0 }] }))).toBeNull();
    expect(parseLayout(JSON.stringify(singlePane({ page: "unknown", extensionId: null } as unknown as WorkspaceTab)))).toBeNull();
    expect(parseLayout(JSON.stringify({ ...singlePane(services), ratio: 99 }))?.ratio).toBe(75);
  });
  test("renders live panes, retains tab state, supports keyboard resize and restores per project", async () => {
    const container = document.createElement("div"); document.body.append(container); containers.push(container);
    const root = createRoot(container);
    function Counter() { const [count, setCount] = useState(0); return <button onClick={() => setCount(count + 1)}>Count {count}</button>; }
    function Harness({ project }: { project: string }) {
      const workspace = useWorkspaceLayout(project, services);
      return <WorkspaceView layout={workspace.layout} update={workspace.update} options={[services, github, docker]} title={(tab) => tab.page} render={(tab) => <div>{tab.page}<Counter /></div>} />;
    }
    await act(async () => root.render(<Harness project="a" />));
    const choose = async (label: string, value: string) => { await act(async () => { const select = container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement; select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }); };
    await act(async () => (container.querySelector('[role="tabpanel"] button') as HTMLButtonElement).click());
    await choose("Open beside", "1");
    expect(container.querySelectorAll('[role="tabpanel"]:not([style*="display: none"])')).toHaveLength(2);
    expect(container.textContent).toContain("Count 1");
    await act(async () => container.querySelector('hr')?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(container.querySelector('hr')?.getAttribute("aria-valuenow")).toBe("55");
    await choose("Open tab", "2");
    await act(async () => (container.querySelector('[role="tab"]') as HTMLButtonElement).click());
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain("Count 1");
    await act(async () => root.render(<Harness project="b" />));
    await act(async () => container.querySelector('hr')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(container.querySelector('hr')?.getAttribute("aria-valuenow")).toBe("25");
    await act(async () => root.render(<Harness project="a" />));
    expect(container.querySelector('hr')?.getAttribute("aria-valuenow")).toBe("55");
    await act(async () => root.unmount());
  });
});
