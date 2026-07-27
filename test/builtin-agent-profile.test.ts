import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  loadBundledDebugProfile,
  NOMOREIDE_DEBUG_PROFILE_NAME,
} from "../src/core/agent-profiles/index.js";

describe("bundled NoMoreIDE debug profile", () => {
  test("ships a valid MCP and triggerable skill pair", async () => {
    const bundled = await loadBundledDebugProfile();

    expect(bundled.profile.name).toBe(NOMOREIDE_DEBUG_PROFILE_NAME);
    expect(bundled.profile.mcps.nomoreide).toEqual({
      kind: "local",
      command: "npx",
      args: ["-y", "nomoreide"],
    });
    expect(bundled.profile.skills).toEqual([{ name: "nomoreide-debug" }]);

    const skillDir = join(bundled.skillsDir, "nomoreide-debug");
    await expect(access(join(skillDir, "SKILL.md"))).resolves.toBeUndefined();
    await expect(access(join(skillDir, "agents", "openai.yaml"))).resolves.toBeUndefined();
    const skill = await readFile(join(skillDir, "SKILL.md"), "utf8");
    expect(skill).toContain("even when they do not mention NoMoreIDE");
  });
});
