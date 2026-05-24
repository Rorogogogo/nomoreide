import { describe, expect, test } from "vitest";
import { deriveServiceLogSource } from "../src/core/service-log-source.js";
import type { ServiceDefinition } from "../src/core/types.js";

const ssh = (command: string, host = "prod"): ServiceDefinition => ({
  name: "svc",
  kind: "ssh",
  host,
  command,
});

describe("deriveServiceLogSource", () => {
  test("derives a journald source from a journalctl -u command", () => {
    expect(deriveServiceLogSource(ssh("journalctl -u jobjourney -f -n 1000 --no-pager"))).toEqual({
      name: "svc",
      kind: "command",
      driver: "journald",
      unit: "jobjourney",
      host: "prod",
    });
  });

  test("handles --unit=NAME form", () => {
    expect(deriveServiceLogSource(ssh("journalctl --unit=api.service -f"))?.unit).toBe("api.service");
  });

  test("derives a docker source from a docker logs command, skipping flag values", () => {
    expect(deriveServiceLogSource(ssh("docker logs -f --tail 200 brainctl-api"))).toEqual({
      name: "svc",
      kind: "command",
      driver: "docker",
      container: "brainctl-api",
      host: "prod",
    });
  });

  test("returns null for a non-queryable ssh command", () => {
    expect(deriveServiceLogSource(ssh("tail -f /var/log/app.log"))).toBeNull();
  });

  test("returns null for local services (no host to re-query)", () => {
    expect(
      deriveServiceLogSource({ name: "web", kind: "local", command: "npm run dev" }),
    ).toBeNull();
  });
});
