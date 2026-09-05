// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { closeTab, mergePanes, moveTab, openTab, parseLayout, singlePane, splitActive, useWorkspaceLayout, type WorkspaceTab } from "@/features/workspace/workspace-layout";
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
  test("dragging a tab across collapses the pane it emptied", () => {
    const split = openTab(openTab(singlePane(services), docker), github, 1);
    // services + docker on the left, github on the right.
    const moved = moveTab(split, 0, 0, 1, 0);
    expect(moved.panes.map((pane) => pane.tabs)).toEqual([[docker], [services, github]]);
    // The tab that moved is the one now showing, in the pane it landed in.
    expect(moved.panes[1].tabs[moved.panes[1].active]).toEqual(services);
    expect(moved.focused).toBe(1);

    // Emptying a pane removes it rather than leaving a blank column.
    const emptied = moveTab(openTab(singlePane(services), github, 1), 1, 0, 0);
    expect(emptied.panes).toEqual([{ id: "primary", tabs: [services, github], active: 1 }]);
  });
  test("dragging reorders within a pane and refuses moves that would empty the workspace", () => {
    const three = openTab(openTab(singlePane(services), github), docker);
    expect(moveTab(three, 0, 0, 0, 2).panes[0].tabs).toEqual([github, docker, services]);
    // The only tab of the only pane has nowhere to go.
    expect(moveTab(singlePane(services), 0, 0, 1)).toEqual(singlePane(services));
    // An index nobody dragged from changes nothing.
    expect(moveTab(three, 0, 9, 1)).toEqual(three);
    /*
      A tab already open in the target is refused rather than duplicated.
      Unreachable through the UI — ids are unique across the whole layout, and
      `openTab` focuses rather than copying — so it is built by hand here. The
      guard exists because a duplicate would render the same page twice and
      `parseLayout` would then reject the layout on the next load.
    */
    const duplicated = { panes: [{ id: "primary" as const, tabs: [services, github], active: 0 }, { id: "secondary" as const, tabs: [services], active: 0 }], focused: 0, ratio: 50 };
    expect(moveTab(duplicated, 0, 0, 1)).toEqual(duplicated);
  });
  test("the split button pulls the active tab out, or brings one in when alone", () => {
    const options = [services, github, docker];
    // More than one tab: the active one moves beside.
    const many = openTab(singlePane(services), github);
    expect(splitActive(many, options).panes.map((pane) => pane.tabs)).toEqual([[services], [github]]);
    // Alone: the first destination not already open joins it.
    expect(splitActive(singlePane(services), options).panes.map((pane) => pane.tabs)).toEqual([[services], [github]]);
    // Already split: nothing to do.
    const split = openTab(singlePane(services), github, 1);
    expect(splitActive(split, options)).toEqual(split);
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
    // The split is a button now, not a page picker: with one tab open it
    // brings in the first destination that is not already showing.
    await act(async () => (container.querySelector('button[aria-label="Open beside"]') as HTMLButtonElement).click());
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
