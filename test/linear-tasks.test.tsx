// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useLinearTasks } from "../apps/dashboard/src/features/linear/use-linear-tasks";
import { linearTaskPrompt, type LinearData, type LinearIssue, type LinearTransport } from "../apps/dashboard/src/features/linear/linear-types";

let root: Root;
let model: ReturnType<typeof useLinearTasks>;
function Harness({ send }: { send: LinearTransport }) { model = useLinearTasks(send); return null; }
async function mount(send: LinearTransport) {
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness send={send} />));
}
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ""; });
const issue = { id: "task-1", identifier: "ENG-1", title: "Fix login", description: "Handle the expired session", branchName: "eng-1-fix-login", url: "https://linear.app/team/issue/ENG-1", priority: 1, state: { id: "todo", name: "Todo" }, team: { id: "team-a", name: "A" }, assignee: null } as LinearIssue;

describe("Linear tasks", () => {
  test("uses the host's repository mapping and retains issue context for the agent", async () => {
    const send = vi.fn<LinearTransport>(async (request) => request.operation === "metadata" ? { binding: { team: "team-a", project: "project-a" }, teams: { nodes: [] } } : { issues: { nodes: [issue], pageInfo: { hasNextPage: false, endCursor: null } } });
    await mount(send);
    expect(send).toHaveBeenCalledWith({ operation: "issues", team: "team-a", project: "project-a", after: undefined });
    expect(model.issues).toHaveLength(1);
    expect(linearTaskPrompt(issue)).toContain(issue.branchName);
    expect(linearTaskPrompt(issue)).toContain(issue.description);
  });
  test("a late list response cannot overwrite a newly selected team", async () => {
    let release: (data: LinearData) => void = () => {};
    await mount(async (request) => {
      if (request.operation === "metadata") return {};
      if (request.operation === "issues" && request.team === "team-a") return new Promise((resolve) => { release = resolve; });
      return { issues: { nodes: [{ ...issue, id: "task-b" }], pageInfo: { hasNextPage: false, endCursor: null } } };
    });
    await act(async () => model.selectTeam("team-a"));
    await act(async () => model.selectTeam("team-b"));
    await act(async () => release({ issues: { nodes: [issue], pageInfo: { hasNextPage: false, endCursor: null } } }));
    expect(model.issues.map((v) => v.id)).toEqual(["task-b"]);
  });
  test("a pending write cannot be submitted twice and failures are visible", async () => {
    let reject: (error: Error) => void = () => {};
    const send = vi.fn<LinearTransport>(async (request) => {
      if (request.operation === "create") return new Promise((_, fail) => { reject = fail; });
      return {};
    });
    await mount(send);
    let first: Promise<boolean>;
    await act(async () => { first = model.create("Task", "Details"); });
    await act(async () => { expect(await model.create("Task", "Details")).toBe(false); });
    await act(async () => { reject(new Error("No permission")); await first; });
    expect(send.mock.calls.filter(([request]) => request.operation === "create")).toHaveLength(1);
    expect(model.error).toBe("No permission");
    expect(model.busy).toBe(false);
  });
});
