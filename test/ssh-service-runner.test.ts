import { describe, expect, test } from "vitest";
import { createSshCommand } from "../src/core/ssh-service-runner.js";

describe("createSshCommand", () => {
  test("uses existing ssh config and runs command in cwd", () => {
    expect(
      createSshCommand({
        host: "devbox",
        cwd: "/srv/app",
        command: "npm run dev",
      }),
    ).toEqual(["ssh", ["devbox", "cd '/srv/app' && exec npm run dev"]]);
  });

  test("prepends env vars before exec", () => {
    expect(
      createSshCommand({
        host: "devbox",
        cwd: "/srv/app",
        command: "node server.js",
        env: { NODE_ENV: "production" },
      }),
    ).toEqual([
      "ssh",
      ["devbox", "cd '/srv/app' && NODE_ENV='production' exec node server.js"],
    ]);
  });

  test("rejects empty host, cwd, or commands with null bytes", () => {
    expect(() =>
      createSshCommand({ host: "", cwd: "/x", command: "y" }),
    ).toThrow(/host/);
    expect(() =>
      createSshCommand({ host: "h", cwd: "", command: "y" }),
    ).toThrow(/cwd/);
    expect(() =>
      createSshCommand({ host: "h", cwd: "/x", command: "y\0z" }),
    ).toThrow(/null byte/);
    expect(() =>
      createSshCommand({
        host: "h",
        cwd: "/x",
        command: "true",
        env: { "BAD-NAME": "value" },
      }),
    ).toThrow(/environment variable name/i);
  });

  test("escapes single quotes in cwd safely", () => {
    const [, args] = createSshCommand({
      host: "h",
      cwd: "/srv/app's",
      command: "ls",
    });
    expect(args[1]).toContain("'/srv/app'\\''s'");
  });
});
