// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const installAgentEnvProfileFromRegistry = vi.hoisted(() => vi.fn());
const listAgentEnvProfiles = vi.hoisted(() => vi.fn());
const getRegistryAuthStatus = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getAgentEnvAgents: vi.fn(async () => []),
  getAgentEnvConfigs: vi.fn(async () => []),
  getAgentEnvDoctor: vi.fn(async () => ({ checks: [] })),
  getRegistryAuthStatus,
  installAgentEnvProfileFromRegistry,
  listAgentEnvProfiles,
}));

import { AgentEnvView } from "../src/web/client/src/features/agent-env/agent-env-view";
import { initialPage, installSlugFromSearch } from "../src/web/client/src/app";

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  listAgentEnvProfiles.mockResolvedValue([]);
  getRegistryAuthStatus.mockResolvedValue({
    signedIn: true,
    apiMode: "prod",
    apiBaseUrl: "https://api.brainctl.net",
    user: { displayName: "Roro", email: "roro@example.com" },
  });
  installAgentEnvProfileFromRegistry.mockResolvedValue({
    name: "review-stack",
    missingCredentials: [],
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
