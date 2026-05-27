import { describe, expect, test } from "vitest";
import { resolveServiceTerminal } from "../src/core/terminal-spawn.js";
import type { ServiceDefinition } from "../src/core/types.js";

describe("resolveServiceTerminal", () => {
  test("local service → shell in cwd with env merged over the environment", () => {
    const service: ServiceDefinition = {
      name: "api",
      command: "npm run dev",
      cwd: "/srv/api",
      env: { FOO: "bar" },
    };
    const resolved = resolveServiceTerminal(service);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.options.cwd).toBe("/srv/api");
    expect(resolved.options.shell).toBeUndefined();
    expect(resolved.options.env?.FOO).toBe("bar");
    // Inherited PATH is preserved alongside the service's own vars.
    expect(resolved.options.env?.PATH).toBe(process.env.PATH);
    expect(resolved.options.label).toBe("api");
  });

  test("ssh service → ssh -t into host, cd-ing into the service dir", () => {
    const service: ServiceDefinition = {
      name: "prod",
      kind: "ssh",
      host: "deploy@example.com",
      cwd: "/var/www/app",
    };
    const resolved = resolveServiceTerminal(service);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.options.shell).toBe("ssh");
    expect(resolved.options.args?.[0]).toBe("-t");
    expect(resolved.options.args?.[1]).toBe("deploy@example.com");
    expect(resolved.options.args?.[2]).toContain("cd '/var/www/app'");
    expect(resolved.options.args?.[2]).toContain('exec "$SHELL" -l');
  });

  test("ssh service with no host is rejected", () => {
    const resolved = resolveServiceTerminal({ name: "prod", kind: "ssh" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toMatch(/host/i);
  });

  test("docker-compose service → docker compose exec, honoring composeFile", () => {
    const service: ServiceDefinition = {
      name: "db",
      kind: "docker-compose",
      cwd: "/srv/stack",
      composeFile: "ops/docker-compose.yml",
      composeService: "postgres",
    };
    const resolved = resolveServiceTerminal(service);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.options.shell).toBe("docker");
    expect(resolved.options.args).toEqual([
      "compose",
      "-f",
      "ops/docker-compose.yml",
      "exec",
      "postgres",
      "sh",
    ]);
    expect(resolved.options.cwd).toBe("/srv/stack");
  });

  test("docker-compose service with no compose service is rejected", () => {
    const resolved = resolveServiceTerminal({
      name: "db",
      kind: "docker-compose",
      cwd: "/srv/stack",
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toMatch(/compose service/i);
  });
});
