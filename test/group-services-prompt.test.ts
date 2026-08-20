import { describe, expect, test } from "vitest";
import { buildGroupServicesPrompt } from "../apps/dashboard/src/features/agent/prompts/group-services";

describe("group services prompt", () => {
  test("lists the ungrouped services and asks for a confirmed grouping", () => {
    const prompt = buildGroupServicesPrompt([
      { name: "web", command: "npm run dev", cwd: "/repo/web", port: 3000 },
      { name: "api", command: "go run .", cwd: "/repo/api", port: 8080 },
    ]);

    expect(prompt).toContain("ungrouped services");
    expect(prompt).toContain("- web");
    expect(prompt).toContain("npm run dev");
    expect(prompt).toContain("port: 3000");
    expect(prompt).toContain("- api");
    // Proposes via clickable options and waits for confirmation before acting.
    expect(prompt).toContain("```options");
    expect(prompt).toContain("Do NOT create anything until I confirm");
    expect(prompt).toContain("nomoreide add bundle");
  });

  test("handles an empty roster without crashing", () => {
    const prompt = buildGroupServicesPrompt([]);
    expect(prompt).toContain("all services are already grouped");
  });
});
