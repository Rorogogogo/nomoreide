import { afterEach, describe, expect, test, vi } from "vitest";
import { httpSkillsApi } from "../apps/dashboard/src/lib/api/skills-http.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remote skills client API", () => {
  test("encodes search queries and returns normalized results", async () => {
    const skills = [
      {
        id: "vercel-labs/skills/find-skills",
        name: "find-skills",
        source: "vercel-labs/skills",
        useSource: "vercel-labs/skills@find-skills",
        installs: 42,
        url: "https://skills.sh/vercel-labs/skills/find-skills",
      },
    ];
    const fetch = vi.fn().mockResolvedValue(
      Response.json({ ok: true, skills }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(httpSkillsApi.searchSkills("react native")).resolves.toEqual(skills);
    expect(fetch).toHaveBeenCalledWith(
      "/api/skills/search?q=react%20native",
      undefined,
    );
  });

  test("loads one-time skill instructions without creating a terminal session", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({ ok: true, prompt: "skill context" }),
    );
    vi.stubGlobal("fetch", fetch);
    const skill = {
      name: "review",
      source: "owner/repo@review",
    };

    await expect(
      httpSkillsApi.loadOneTimeSkillPrompt(skill),
    ).resolves.toBe("skill context");
    expect(fetch).toHaveBeenCalledWith("/api/skills/use", {
      body: JSON.stringify({ skill }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  });
});
