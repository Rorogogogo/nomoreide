import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import {
  mergeSshServers,
  parseRemoteMetrics,
  parseSshConfigHosts,
} from "../src/core/ssh-servers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("SSH servers", () => {
  test("discovers explicit aliases and ignores wildcard host rules", () => {
    expect(parseSshConfigHosts(`
      Host prod-api prod-worker
        HostName 10.0.0.8
      Host *.internal !blocked.internal
      Host staging
    `)).toEqual(["prod-api", "prod-worker", "staging"]);
  });

  test("merges saved metadata with discovered aliases", () => {
    expect(
      mergeSshServers(
        [{ host: "prod", name: "Production", environment: "Production" }],
        ["prod", "staging"],
      ),
    ).toEqual([
      {
        host: "prod",
        name: "Production",
        environment: "Production",
        discovered: true,
        saved: true,
      },
      { host: "staging", discovered: true, saved: false },
    ]);
  });

  test("parses the fixed Linux metrics response", () => {
    const metrics = parseRemoteMetrics("prod", `NMI_META\tapi-01\tLinux
NMI_CPU\t12.5
NMI_MEMORY\t1000\t250
NMI_LOAD\t0.25\t0.20\t0.10
NMI_UPTIME\t90061.2
NMI_CPUS\t4
NMI_DISK\t2000\t500\t1500
NMI_PROCESSES
  42 1 deploy 8.5 2048 node server.js
`, 1234);

    expect(metrics.hostname).toBe("api-01");
    expect(metrics.current).toMatchObject({
      t: 1234,
      cpuPercent: 12.5,
      memoryTotalBytes: 1_024_000,
      memoryUsedBytes: 768_000,
      memoryUsedPercent: 75,
      logicalCpuCount: 4,
    });
    expect(metrics.current.disk?.usedPercent).toBe(25);
    expect(metrics.processes).toEqual([
      {
        pid: 42,
        ppid: 1,
        user: "deploy",
        cpuPercent: 8.5,
        rssMb: 2,
        command: "node server.js",
      },
    ]);
  });

  test("persists server metadata without credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nomoreide-ssh-servers-"));
    tempDirs.push(directory);
    const store = new ConfigStore(join(directory, "config.json"));

    await store.registerSshServer({
      host: "prod-api",
      name: "Production API",
      environment: "Production",
    });

    expect((await store.load()).sshServers).toEqual([
      {
        host: "prod-api",
        name: "Production API",
        environment: "Production",
      },
    ]);

    await store.removeSshServer("prod-api");
    expect((await store.load()).sshServers).toEqual([]);
  });

  test("rejects host values that could be interpreted as SSH options", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nomoreide-ssh-servers-"));
    tempDirs.push(directory);
    const store = new ConfigStore(join(directory, "config.json"));

    await expect(store.registerSshServer({ host: "-oProxyCommand=bad" })).rejects.toThrow(
      /SSH host/,
    );
  });
});
