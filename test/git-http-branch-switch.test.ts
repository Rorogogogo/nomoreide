import { afterEach, describe, expect, test, vi } from "vitest";
import { httpGitApi } from "../apps/dashboard/src/lib/api/git-http";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HTTP Git branch switching", () => {
  test("sends the form body expected by the branch route", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await httpGitApi.gitSwitchBranch("feature/header-switcher");

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/git/branches/switch");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(new URLSearchParams(init.body as URLSearchParams).get("name")).toBe(
      "feature/header-switcher",
    );
  });

  test.each([
    ["gitPull", "/api/git/pull", null],
    ["gitMerge", "/api/git/merge", "feature/merge-me"],
    ["gitRebase", "/api/git/rebase", "feature/base"],
  ] as const)("sends form data for %s", async (method, expectedUrl, branch) => {
    const fetch = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true, output: "done" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    if (method === "gitPull") await httpGitApi.gitPull();
    else {
      if (!branch) throw new Error(`${method} requires a branch`);
      await httpGitApi[method](branch);
    }

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as URLSearchParams);
    expect(url).toBe(expectedUrl);
    expect(init.method).toBe("POST");
    expect(body.get("branch")).toBe(branch);
  });

  test("passes a start point when creating and uses the safe delete route", async () => {
    const fetch = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true, output: "done" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await httpGitApi.gitCreateBranch("feature/derived", "feature/source");
    await httpGitApi.gitDeleteBranch("feature/old");

    const [createUrl, createInit] = fetch.mock.calls[0] as [string, RequestInit];
    const createBody = new URLSearchParams(createInit.body as URLSearchParams);
    expect(createUrl).toBe("/api/git/branches");
    expect(createBody.get("name")).toBe("feature/derived");
    expect(createBody.get("startPoint")).toBe("feature/source");

    const [deleteUrl, deleteInit] = fetch.mock.calls[1] as [string, RequestInit];
    const deleteBody = new URLSearchParams(deleteInit.body as URLSearchParams);
    expect(deleteUrl).toBe("/api/git/branches/delete");
    expect(deleteBody.get("name")).toBe("feature/old");
  });
});
