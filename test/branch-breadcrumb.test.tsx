// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BranchBreadcrumb } from "../src/web/client/src/features/git/branch-breadcrumb";
import type { GitBranch } from "../src/web/client/src/lib/api";

const mocks = vi.hoisted(() => ({
  gitCreateBranch: vi.fn(),
  gitDeleteBranch: vi.fn(),
  gitFetch: vi.fn(),
  gitMerge: vi.fn(),
  gitPull: vi.fn(),
  gitPush: vi.fn(),
  gitRebase: vi.fn(),
  gitSwitchBranch: vi.fn(),
  showError: vi.fn(),
  showSuccess: vi.fn(),
}));

vi.mock("@/components/ui/toast", () => ({
  useToasts: () => ({ error: mocks.showError, success: mocks.showSuccess }),
}));

vi.mock("@/lib/api", () => ({
  gitCreateBranch: mocks.gitCreateBranch,
  gitDeleteBranch: mocks.gitDeleteBranch,
  gitFetch: mocks.gitFetch,
  gitMerge: mocks.gitMerge,
  gitPull: mocks.gitPull,
  gitPush: mocks.gitPush,
  gitRebase: mocks.gitRebase,
  gitSwitchBranch: mocks.gitSwitchBranch,
}));

const BRANCHES: GitBranch[] = [
  { name: "main", current: true, remote: false, upstream: "origin/main" },
  { name: "feature/header-switcher", current: false, remote: false },
  { name: "origin/release", current: false, remote: true },
];

let container: HTMLDivElement;
let root: Root;
let refresh: ReturnType<typeof vi.fn>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  refresh = vi.fn().mockResolvedValue(undefined);
  mocks.gitCreateBranch.mockResolvedValue("");
  mocks.gitDeleteBranch.mockResolvedValue("");
  mocks.gitFetch.mockResolvedValue("");
  mocks.gitMerge.mockResolvedValue("");
  mocks.gitPull.mockResolvedValue("");
  mocks.gitPush.mockResolvedValue({ output: "", branch: "main", setUpstream: false });
  mocks.gitRebase.mockResolvedValue("");
  mocks.gitSwitchBranch.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** The app's ConfirmDialog replaced `window.confirm`; it portals to the body. */
function confirmDialog(): HTMLElement {
  // The branch popover is a role="dialog" too; only the modal is the confirm.
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
  if (!dialog) throw new Error("confirm dialog did not open");
  return dialog;
}

function dialogButton(label: string): HTMLButtonElement {
  const button = [...confirmDialog().querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`no "${label}" button in the confirm dialog`);
  return button;
}

function renderBreadcrumb(options: { disabled?: boolean } = {}) {
  act(() => {
    root.render(
      <BranchBreadcrumb
        ahead={2}
        behind={1}
        branches={BRANCHES}
        currentBranch="main"
        disabled={options.disabled}
        onRefresh={refresh}
        upstream="origin/main"
      />,
    );
  });
}

function openMenu() {
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Switch Git branch"]',
  );
  act(() => trigger?.click());
  const menu = document.querySelector('[role="dialog"]');
  if (!menu) throw new Error("branch menu did not open");
  return menu;
}

function findBranch(menu: Element, name: string) {
  return [...menu.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === name,
  );
}

function findAction(menu: Element, label: string) {
  void menu;
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent === label,
  );
}

describe("BranchBreadcrumb", () => {
  test("offers fetch, pull, push, and branch creation", async () => {
    renderBreadcrumb();
    const menu = openMenu();
    const button = (label: string) =>
      [...menu.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent === label,
      );

    await act(async () => button("Fetch")?.click());
    await act(async () => button("Pull 1")?.click());
    await act(async () => button("Push 2")?.click());

    expect(mocks.gitFetch).toHaveBeenCalledOnce();
    expect(mocks.gitPull).toHaveBeenCalledOnce();
    expect(mocks.gitPush).toHaveBeenCalledOnce();

    act(() => button("New")?.click());
    const input = menu.querySelector<HTMLInputElement>('input[aria-label="New branch name"]');
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(input, "feature/new-command");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input?.form?.requestSubmit());

    expect(mocks.gitCreateBranch).toHaveBeenCalledWith("feature/new-command", undefined);
    expect(mocks.showSuccess).toHaveBeenCalledWith(
      "Created and switched to feature/new-command.",
    );
  });

  test("shows blue incoming and green outgoing branch counts", () => {
    renderBreadcrumb();
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Switch Git branch"]',
    );
    const incoming = trigger?.querySelector<HTMLElement>('[title="1 behind"]');
    const outgoing = trigger?.querySelector<HTMLElement>('[title="2 ahead"]');

    expect(incoming?.textContent).toBe("1");
    expect(incoming?.className).toContain("text-sky-500");
    expect(outgoing?.textContent).toBe("2");
    expect(outgoing?.className).toContain("text-emerald-500");
  });

  test("weights the branch names inside menu sentences, not the connective words", () => {
    renderBreadcrumb();
    const menu = openMenu();
    act(() => findBranch(menu, "feature/header-switcher")?.click());
    const merge = findAction(menu, "Merge feature/header-switcher into main");

    // Both names are emphasised, and the words between them are not — the rows
    // differ only by those names, so they have to be findable at a glance.
    const emphasised = [...(merge?.querySelectorAll("span.font-semibold") ?? [])].map(
      (node) => node.textContent,
    );
    expect(emphasised).toEqual(["feature/header-switcher", "main"]);
    // Still one sentence: the split must not reach screen readers as fragments.
    expect(merge?.textContent).toBe("Merge feature/header-switcher into main");
  });

  test("confirms merge and rebase actions for another branch", async () => {
    renderBreadcrumb();
    const menu = openMenu();
    act(() => findBranch(menu, "feature/header-switcher")?.click());
    const merge = findAction(menu, "Merge feature/header-switcher into main");
    const rebase = findAction(menu, "Rebase main onto feature/header-switcher");

    // Neither action runs on the click alone — each asks in the app's dialog,
    // and it is the dialog's own button that commits it.
    await act(async () => merge?.click());
    expect(confirmDialog().textContent).toContain("Merge feature/header-switcher into main?");
    expect(mocks.gitMerge).not.toHaveBeenCalled();
    await act(async () => dialogButton("Merge").click());

    await act(async () => rebase?.click());
    expect(confirmDialog().textContent).toContain("Rebase main onto feature/header-switcher?");
    expect(confirmDialog().textContent).toContain("rewrites local commit history");
    await act(async () => dialogButton("Rebase").click());

    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
    expect(mocks.gitMerge).toHaveBeenCalledWith("feature/header-switcher");
    expect(mocks.gitRebase).toHaveBeenCalledWith("feature/header-switcher");
    expect(mocks.showSuccess).toHaveBeenCalledWith(
      "Merged feature/header-switcher into main.",
    );
    expect(mocks.showSuccess).toHaveBeenCalledWith(
      "Rebased main onto feature/header-switcher.",
    );
  });

  test("opens an IDE-style menu with checkout first", () => {
    renderBreadcrumb();
    const menu = openMenu();

    act(() => findBranch(menu, "feature/header-switcher")?.click());
    const flyout = document.querySelector(
      '[role="menu"][aria-label="Actions for feature/header-switcher"]',
    );
    if (!flyout) throw new Error("branch action flyout did not open");
    const actions = [...flyout.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];

    expect(menu.contains(flyout)).toBe(false);
    expect(actions.map((button) => button.textContent)).toEqual([
      "Checkout",
      "Create new branch from feature/header-switcher",
      "Merge feature/header-switcher into main",
      "Rebase main onto feature/header-switcher",
      "Delete local branch",
    ]);
  });

  test("creates from the selected branch and safely deletes a local branch", async () => {
    renderBreadcrumb();
    const menu = openMenu();

    act(() => findBranch(menu, "feature/header-switcher")?.click());
    act(() => findAction(menu, "Create new branch from feature/header-switcher")?.click());
    const input = menu.querySelector<HTMLInputElement>('input[aria-label="New branch name"]');
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(input, "feature/from-selected");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input?.form?.requestSubmit());

    expect(mocks.gitCreateBranch).toHaveBeenCalledWith(
      "feature/from-selected",
      "feature/header-switcher",
    );

    renderBreadcrumb();
    const reopened = openMenu();
    act(() => findBranch(reopened, "feature/header-switcher")?.click());
    await act(async () => findAction(reopened, "Delete local branch")?.click());
    expect(confirmDialog().textContent).toContain(
      "Delete local branch feature/header-switcher?",
    );
    await act(async () => dialogButton("Delete").click());

    expect(mocks.gitDeleteBranch).toHaveBeenCalledWith("feature/header-switcher");
    expect(mocks.showSuccess).toHaveBeenCalledWith(
      "Deleted local branch feature/header-switcher.",
    );
  });

  test("separates local and remote branches and marks the current branch", () => {
    renderBreadcrumb();
    const menu = openMenu();

    expect(menu.querySelector('section[aria-label="Local"]')?.textContent).toContain(
      "feature/header-switcher",
    );
    expect(menu.querySelector('section[aria-label="Remote"]')?.textContent).toContain(
      "origin/release",
    );
    act(() => findBranch(menu, "main")?.click());
    expect(findAction(menu, "Checkout (current)")?.disabled).toBe(true);
    expect(findAction(menu, "Delete local branch")?.disabled).toBe(true);
  });

  test("filters branches by name", () => {
    renderBreadcrumb();
    const menu = openMenu();
    const search = menu.querySelector<HTMLInputElement>('input[aria-label="Search branches"]');

    act(() => {
      if (!search) throw new Error("search input was not rendered");
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(search, "release");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(findBranch(menu, "origin/release")).toBeTruthy();
    expect(findBranch(menu, "main")).toBeUndefined();
  });

  test("switches branch, refreshes dashboard data, and closes", async () => {
    renderBreadcrumb();
    const menu = openMenu();

    act(() => findBranch(menu, "feature/header-switcher")?.click());
    await act(async () => findAction(menu, "Checkout")?.click());

    expect(mocks.gitSwitchBranch).toHaveBeenCalledWith("feature/header-switcher");
    expect(refresh).toHaveBeenCalledOnce();
    expect(mocks.showSuccess).toHaveBeenCalledWith("Switched to feature/header-switcher.");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test("keeps the menu open and reports checkout errors", async () => {
    mocks.gitSwitchBranch.mockRejectedValueOnce(new Error("local changes would be overwritten"));
    renderBreadcrumb();
    const menu = openMenu();

    act(() => findBranch(menu, "feature/header-switcher")?.click());
    await act(async () => findAction(menu, "Checkout")?.click());

    expect(refresh).not.toHaveBeenCalled();
    expect(mocks.showError).toHaveBeenCalledWith("local changes would be overwritten");
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  });

  test("cannot open when Git status is unavailable", () => {
    renderBreadcrumb({ disabled: true });
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Switch Git branch"]',
    );

    expect(trigger?.disabled).toBe(true);
    act(() => trigger?.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
