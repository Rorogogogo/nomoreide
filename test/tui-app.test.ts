import { describe, expect, test } from "vitest";
import { renderTuiScreen } from "../src/tui/app.js";

describe("TUI app", () => {
  test("renders registered services, bundles, and key commands", () => {
    const screen = renderTuiScreen({
      mode: "services",
      selectedIndex: 0,
      config: {
        version: 1,
        services: [
          {
            name: "backend",
            command: "npm run dev",
            cwd: "/repo/backend",
            port: 3001,
            description: "API",
          },
        ],
        bundles: [{ name: "full-stack", services: ["backend"] }],
      },
      runtime: {
        services: {
          backend: {
            name: "backend",
            state: "running",
            pid: 1234,
          },
        },
      },
      logs: [],
    });

    expect(screen).toContain("NoMoreIDE");
    expect(screen).toContain("> backend");
    expect(screen).toContain("running");
    expect(screen).toContain("3001");
    expect(screen).toContain("full-stack");
    expect(screen).toContain("s start");
    expect(screen).toContain("q quit");
  });
});
