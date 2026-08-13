// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const installAgentEnvProfileFromRegistry = vi.hoisted(() => vi.fn());
const listAgentEnvProfiles = vi.hoisted(() => vi.fn());
const listAgentEnvRegistryProfiles = vi.hoisted(() => vi.fn());
const getRegistryAuthStatus = vi.hoisted(() => vi.fn());
const getAgentEnvProfileRegistryDiff = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getAgentEnvAgents: vi.fn(async () => []),
  getAgentEnvConfigs: vi.fn(async () => []),
  getAgentEnvDoctor: vi.fn(async () => ({ checks: [] })),
  getRegistryAuthStatus,
  getAgentEnvProfileRegistryDiff,
  installAgentEnvProfileFromRegistry,
  listAgentEnvProfiles,
  listAgentEnvRegistryProfiles,
}));

import { AgentEnvView } from "../src/web/client/src/features/agent-env/agent-env-view";
import { initialPage, installSlugFromSearch } from "../src/web/client/src/app";

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  listAgentEnvProfiles.mockResolvedValue([]);
  listAgentEnvRegistryProfiles.mockResolvedValue([
    {
      id: "profile-1",
      slug: "review-stack",
      title: "Review Stack",
      summary: "Review tools",
      version: "1.2.0",
      sourceKind: "hosted",
      starsCount: 4,
      downloadsCount: 12,
      mcpCount: 1,
      skillCount: 2,
      pluginCount: 0,
    },
  ]);
  getRegistryAuthStatus.mockResolvedValue({
    signedIn: true,
    apiMode: "prod",
    apiBaseUrl: "https://api.brainctl.net",
    apiFrontendUrl: "https://www.brainctl.net",
    user: { displayName: "Roro", email: "roro@example.com" },
  });
  installAgentEnvProfileFromRegistry.mockResolvedValue({
    name: "review-stack",
    missingCredentials: [],
  });
  getAgentEnvProfileRegistryDiff.mockResolvedValue({
    link: {
      origin: "published",
      slug: "review-stack",
      version: "1.1.0",
      linkedAt: "2026-08-01T00:00:00Z",
    },
    diff: {
      descriptionChanged: true,
      sourceAgentChanged: false,
      hasLocalChanges: true,
      mcps: { added: ["docs"], removed: [], changed: [] },
      skills: { added: [], removed: [], changed: [] },
      plugins: { added: [], removed: [], changed: [] },
    },
  });
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.clearAllMocks();
  document.body.replaceChildren();
});

async function renderView(props: {
  installSlug?: string | null;
  onInstallHandled?: () => void;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<AgentEnvView {...props} />);
  });
  return { host, root };
}

describe("registry deep link (?install=<slug>)", () => {
  test("reads the slug out of the query string", () => {
    expect(installSlugFromSearch("?install=review-stack")).toBe("review-stack");
    // The registry encodes the slug; URLSearchParams decodes it.
    expect(installSlugFromSearch("?install=scope%2Freview")).toBe("scope/review");
    expect(installSlugFromSearch("?other=1&install=review-stack&x=2")).toBe("review-stack");
  });

  test("treats a missing, empty, or whitespace-only slug as no deep link", () => {
    expect(installSlugFromSearch("")).toBeNull();
    expect(installSlugFromSearch("?install=")).toBeNull();
    expect(installSlugFromSearch("?install=%20%20")).toBeNull();
    expect(installSlugFromSearch("?page=agent-env")).toBeNull();
  });

  test("opens Agent Environments even though the link lands on /", () => {
    expect(initialPage({ pathname: "/", search: "?install=review-stack" })).toBe("agent-env");
    // Without the param "/" still means Services.
    expect(initialPage({ pathname: "/", search: "" })).toBe("services");
    // A normal path is unaffected.
    expect(initialPage({ pathname: "/database", search: "" })).toBe("database");
    // An install param anywhere wins over the path.
    expect(initialPage({ pathname: "/database", search: "?install=review-stack" })).toBe(
      "agent-env",
    );
  });

  test("installs the slug once and opens on the Profiles tab", async () => {
    const onInstallHandled = vi.fn();
    const { host } = await renderView({ installSlug: "review-stack", onInstallHandled });

    expect(installAgentEnvProfileFromRegistry).toHaveBeenCalledTimes(1);
    expect(installAgentEnvProfileFromRegistry).toHaveBeenCalledWith({ slug: "review-stack" });
    expect(onInstallHandled).toHaveBeenCalledTimes(1);

    const profilesTab = Array.from(host.querySelectorAll('[role="tab"]')).find((tab) =>
      tab.textContent?.includes("Profiles"),
    );
    expect(profilesTab?.getAttribute("aria-selected")).toBe("true");
  });

  test("does not install anything without a slug", async () => {
    const { host } = await renderView({});
    expect(installAgentEnvProfileFromRegistry).not.toHaveBeenCalled();

    const agentsTab = Array.from(host.querySelectorAll('[role="tab"]')).find((tab) =>
      tab.textContent?.includes("Agents"),
    );
    expect(agentsTab?.getAttribute("aria-selected")).toBe("true");
  });

  test("keeps registry controls in the header across both tabs", async () => {
    const { host } = await renderView({});
    const agentSlugInput = host.querySelector('[aria-label="Registry profile slug"]');
    expect(agentSlugInput).toBeInstanceOf(HTMLInputElement);
    expect(agentSlugInput?.closest("header")).not.toBeNull();

    const profilesTab = Array.from(host.querySelectorAll('[role="tab"]')).find((tab) =>
      tab.textContent?.includes("Profiles"),
    ) as HTMLButtonElement;
    await act(async () => {
      profilesTab.click();
    });

    const slugInput = host.querySelector('[aria-label="Registry profile slug"]');
    expect(slugInput).toBeInstanceOf(HTMLInputElement);
    expect(slugInput?.closest("header")).not.toBeNull();
    expect(slugInput?.closest("header")?.textContent).toContain("Roro");
  });

  test("opens the configured registry frontend from the header", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { host } = await renderView({});
    const browse = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Popular profiles",
    ) as HTMLButtonElement;

    await act(async () => {
      browse.click();
    });

    expect(open).toHaveBeenCalledWith(
      "https://www.brainctl.net",
      "_blank",
      "noopener,noreferrer",
    );
  });

  test("browses hosted profiles and installs with collision confirmation", async () => {
    installAgentEnvProfileFromRegistry.mockRejectedValueOnce(
      new Error('Profile "review-stack" already exists.'),
    );
    const { host } = await renderView({});
    const profilesTab = Array.from(host.querySelectorAll('[role="tab"]')).find((tab) =>
      tab.textContent?.includes("Profiles"),
    ) as HTMLButtonElement;
    await act(async () => {
      profilesTab.click();
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 5));
    });

    expect(listAgentEnvRegistryProfiles).toHaveBeenCalledWith({
      query: "",
      sort: "recent",
    });
    const localPane = host.querySelector('[aria-labelledby="agent-profiles-local-title"]');
    const popularPane = host.querySelector('[aria-labelledby="agent-profiles-registry-title"]');
    expect(localPane?.parentElement?.className).toContain("md:grid-cols-2");
    expect(localPane?.compareDocumentPosition(popularPane as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(host.textContent).toContain("Review Stack");

    const install = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Install" && !button.disabled,
    ) as HTMLButtonElement;
    await act(async () => {
      install.click();
    });

    expect(installAgentEnvProfileFromRegistry).toHaveBeenCalledTimes(1);
    expect(installAgentEnvProfileFromRegistry).toHaveBeenCalledWith({ slug: "review-stack" });
    expect(document.body.textContent).toContain("Replace profile");
    expect(installAgentEnvProfileFromRegistry).not.toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
  });

  test("shows linked publication state and an on-demand local diff", async () => {
    listAgentEnvProfiles.mockResolvedValue([
      {
        name: "review-stack",
        mcpCount: 1,
        skillCount: 1,
        pluginCount: 0,
        updatedAt: "2026-08-01T00:00:00Z",
        registry: {
          origin: "published",
          slug: "review-stack",
          version: "1.1.0",
          linkedAt: "2026-08-01T00:00:00Z",
          hasLocalChanges: true,
        },
      },
    ]);
    const { host } = await renderView({});
    const profilesTab = Array.from(host.querySelectorAll('[role="tab"]')).find((tab) =>
      tab.textContent?.includes("Profiles"),
    ) as HTMLButtonElement;
    await act(async () => {
      profilesTab.click();
      await Promise.resolve();
    });

    const stateButton = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Local + online changes"),
    ) as HTMLButtonElement;
    expect(stateButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      stateButton.click();
      await Promise.resolve();
    });

    expect(getAgentEnvProfileRegistryDiff).toHaveBeenCalledWith("review-stack");
    expect(host.textContent).toContain("Description changed locally.");
    expect(host.textContent).toContain("Added: docs");
    expect(host.textContent).toContain("Publish update");
  });

  test("shows an honest unknown status and opens publish for an unlinked profile", async () => {
    listAgentEnvProfiles.mockResolvedValue([
      {
        name: "snapshot",
        mcpCount: 2,
        skillCount: 1,
        pluginCount: 0,
        updatedAt: "2026-08-01T00:00:00Z",
      },
    ]);
    const { host } = await renderView({});
    const profilesTab = Array.from(host.querySelectorAll('[role="tab"]')).find((tab) =>
      tab.textContent?.includes("Profiles"),
    ) as HTMLButtonElement;
    await act(async () => {
      profilesTab.click();
      await Promise.resolve();
    });

    const unpublished = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Publish status unknown"),
    ) as HTMLButtonElement;
    expect(unpublished).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      unpublished.click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Publish profile");
  });

  test("prompts instead of overwriting when the profile name is taken locally", async () => {
    installAgentEnvProfileFromRegistry.mockRejectedValueOnce(
      new Error('Profile "review-stack" already exists.'),
    );
    const { host } = await renderView({ installSlug: "review-stack" });

    // Only the non-forced attempt ran — a deep link must not clobber local work
    // before the user has seen the prompt.
    expect(installAgentEnvProfileFromRegistry).toHaveBeenCalledTimes(1);
    expect(installAgentEnvProfileFromRegistry).not.toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );

    const dialog = document.body.textContent ?? "";
    expect(dialog).toContain("review-stack");
    expect(dialog).toContain("Replace profile");

    const replace = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Replace profile",
    ) as HTMLButtonElement;
    await act(async () => {
      replace.click();
    });

    expect(installAgentEnvProfileFromRegistry).toHaveBeenCalledTimes(2);
    expect(installAgentEnvProfileFromRegistry).toHaveBeenLastCalledWith({
      slug: "review-stack",
      force: true,
    });
    expect(host).toBeTruthy();
  });

  test("cancelling the prompt leaves the local profile alone", async () => {
    installAgentEnvProfileFromRegistry.mockRejectedValueOnce(
      new Error('Profile "review-stack" already exists.'),
    );
    await renderView({ installSlug: "review-stack" });

    const cancel = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Cancel",
    ) as HTMLButtonElement;
    await act(async () => {
      cancel.click();
    });

    expect(installAgentEnvProfileFromRegistry).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("Replace profile");
  });
});
