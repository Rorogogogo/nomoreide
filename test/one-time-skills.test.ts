import { execFile } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import {
  composeOneTimeSkillPrompt,
  OneTimeSkillError,
  resolveOneTimeSkill,
  searchRemoteSkills,
  validateOneTimeSkill,
} from "../src/core/one-time-skills.js";

describe("skills.sh search", () => {
  test("normalizes public GitHub results into safe one-time sources", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        skills: [
          {
            id: "vercel-labs/skills/find-skills",
            name: "Find Skills",
            source: "vercel-labs/skills",
            installs: 1234.9,
          },
          {
            id: "not-a-repository/skill",
            name: "Ignored",
            source: "not-a-repository",
            installs: 1,
          },
        ],
      }),
    );

    await expect(searchRemoteSkills(" react ", { fetch })).resolves.toEqual([
      {
        id: "vercel-labs/skills/find-skills",
        name: "Find Skills",
        source: "vercel-labs/skills",
        useSource: "vercel-labs/skills@find-skills",
        installs: 1234,
        url: "https://skills.sh/vercel-labs/skills/find-skills",
      },
    ]);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://skills.sh/api/search?q=react&limit=6",
    );
  });

  test("validates query boundaries and upstream response shape", async () => {
    await expect(searchRemoteSkills("x")).rejects.toMatchObject({
      code: "invalid_query",
    });
    await expect(
      searchRemoteSkills("react", {
        fetch: vi.fn().mockResolvedValue(Response.json({ data: [] })),
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("stops reading an oversized chunked search response", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(200 * 1024));
        controller.enqueue(new Uint8Array(100 * 1024));
        controller.close();
      },
    });

    await expect(
      searchRemoteSkills("react", {
        fetch: vi.fn().mockResolvedValue(new Response(body)),
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("one-time skill resolution", () => {
  const selection = {
    name: "find-skills",
    source: "vercel-labs/skills@find-skills",
  };

  test("runs the pinned official CLI without a shell", async () => {
    const run = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        _options: unknown,
        callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        callback(null, Buffer.from("Temporary instructions\n"), Buffer.alloc(0));
        return {} as ReturnType<typeof execFile>;
      },
    ) as unknown as typeof execFile;

    await expect(resolveOneTimeSkill(selection, { execFile: run })).resolves.toBe(
      "Temporary instructions\n",
    );
    expect(run).toHaveBeenCalledWith(
      "npx",
      ["--yes", "skills@1.5.20", "use", "vercel-labs/skills@find-skills"],
      expect.objectContaining({
        maxBuffer: 256 * 1024,
        timeout: 60_000,
        windowsHide: true,
      }),
      expect.any(Function),
    );
  });

  test("rejects option-like sources and composes the user request", () => {
    expect(() =>
      validateOneTimeSkill({ name: "bad", source: "owner/repo@--help" }),
    ).toThrow(OneTimeSkillError);
    expect(composeOneTimeSkillPrompt("Skill instructions\n", "Do the work")).toBe(
      "Skill instructions\n\nUser's request:\nDo the work",
    );
  });
});
