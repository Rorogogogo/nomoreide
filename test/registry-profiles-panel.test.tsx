// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RegistryProfilesPanel } from "../src/web/client/src/features/agent-env/registry-profiles-panel";
import type { useRegistryProfiles } from "../src/web/client/src/features/agent-env/use-registry-profiles";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("RegistryProfilesPanel", () => {
  test("shows the package author when the registry provides one", async () => {
    const catalog: ReturnType<typeof useRegistryProfiles> = {
      error: null,
      loading: false,
      profiles: [
        {
          id: "profile-1",
          slug: "review-stack",
          title: "Review Stack",
          summary: "Review tools",
          version: "1.2.0",
          sourceKind: "hosted",
          starsCount: 4,
          downloadsCount: 12,
          author: { id: "author-1", displayName: "Ada Lovelace" },
          mcpCount: 1,
          skillCount: 2,
          pluginCount: 0,
        },
      ],
      query: "",
      retry: vi.fn(),
      setQuery: vi.fn(),
      setSort: vi.fn(),
      sort: "recent",
    };

    await act(async () => {
      root.render(
        <RegistryProfilesPanel
          busy={false}
          catalog={catalog}
          onInstall={vi.fn(async () => true)}
        />,
      );
    });

    expect(host.textContent).toContain("Ada Lovelace");
  });
});
