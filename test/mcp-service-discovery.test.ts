import { describe, expect, test } from "vitest";
import { buildServiceDiscovery } from "../src/mcp/tools/services.js";

describe("MCP service discovery", () => {
  test("returns runtime definitions without exposing environment values", () => {
    const discovery = buildServiceDiscovery({
      services: [
        {
          name: "api",
          command: "npm run dev",
          cwd: "/workspace/api",
          port: 3000,
          env: {
            API_TOKEN: "secret-value",
            NODE_ENV: "development",
          },
        },
      ],
      bundles: [{ name: "app", services: ["api"] }],
    });

    expect(discovery).toEqual({
      services: [
        {
          name: "api",
          command: "npm run dev",
          cwd: "/workspace/api",
          port: 3000,
          envKeys: ["API_TOKEN", "NODE_ENV"],
        },
      ],
      bundles: [{ name: "app", services: ["api"] }],
    });
    expect(JSON.stringify(discovery)).not.toContain("secret-value");
  });
});
