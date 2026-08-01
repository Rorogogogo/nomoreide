import { describe, expect, test } from "vitest";
import { parseDockerJsonLines, readString } from "../src/core/docker.js";
import {
  parseDockerMemoryUsageMb,
  parseDockerStatsLines,
  parsePercent,
} from "../src/core/docker-stats.js";
import {
  parseDockerImageLines,
  parseDockerNetworkLines,
  parseDockerVolumeLines,
} from "../src/core/docker-resources.js";
import { mapInspectDocument, parseEnvList } from "../src/core/docker-inspect.js";

describe("parseDockerJsonLines", () => {
  test("skips malformed lines instead of failing the whole read", () => {
    const stdout = ['{"Name":"a"}', "not json at all", "", '{"Name":"b"}'].join("\n");
    const rows = parseDockerJsonLines(stdout, (raw) => readString(raw, "Name") || null);
    expect(rows).toEqual(["a", "b"]);
  });
});

describe("parseDockerStatsLines", () => {
  test("parses percentages and keeps raw usage strings", () => {
    const stdout = JSON.stringify({
      ID: "abc123",
      CPUPerc: "2.43%",
      MemPerc: "9.10%",
      MemUsage: "184MiB / 2GiB",
      NetIO: "1.2kB / 648B",
      BlockIO: "0B / 4.1kB",
    });
    expect(parseDockerStatsLines(stdout)).toEqual([
      {
        id: "abc123",
        cpuPercent: 2.43,
        memoryPercent: 9.1,
        memoryUsage: "184MiB / 2GiB",
        netIo: "1.2kB / 648B",
        blockIo: "0B / 4.1kB",
      },
    ]);
  });

  test("reports null rather than NaN when Docker has no sample", () => {
    const stdout = JSON.stringify({ ID: "abc", CPUPerc: "--", MemPerc: "--" });
    const [row] = parseDockerStatsLines(stdout);
    expect(row.cpuPercent).toBeNull();
    expect(row.memoryPercent).toBeNull();
  });

  test("parsePercent tolerates blanks and stray whitespace", () => {
    expect(parsePercent(" 12.5% ")).toBe(12.5);
    expect(parsePercent("")).toBeNull();
  });

  test("parses Docker memory usage into MiB", () => {
    expect(parseDockerMemoryUsageMb("184MiB / 2GiB")).toBe(184);
    expect(parseDockerMemoryUsageMb("1.5GiB / 4GiB")).toBe(1536);
    expect(parseDockerMemoryUsageMb("--")).toBeNull();
  });
});

describe("parseDockerImageLines", () => {
  test("flags untagged layers as dangling", () => {
    const stdout = [
      JSON.stringify({
        ID: "sha256:aaa",
        Repository: "postgres",
        Tag: "16",
        Size: "417MB",
        CreatedSince: "2 days ago",
      }),
      JSON.stringify({
        ID: "sha256:bbb",
        Repository: "<none>",
        Tag: "<none>",
        Size: "88MB",
        CreatedSince: "3 weeks ago",
      }),
    ].join("\n");
    const rows = parseDockerImageLines(stdout);
    expect(rows.map((row) => row.dangling)).toEqual([false, true]);
    expect(rows[0].repository).toBe("postgres");
  });
});

describe("parseDockerVolumeLines / parseDockerNetworkLines", () => {
  test("maps the fields each table renders", () => {
    const volumes = parseDockerVolumeLines(
      JSON.stringify({
        Name: "app_pgdata",
        Driver: "local",
        Mountpoint: "/var/lib/docker/volumes/app_pgdata/_data",
        Scope: "local",
      }),
    );
    expect(volumes[0].mountpoint).toContain("app_pgdata");

    const networks = parseDockerNetworkLines(
      JSON.stringify({ ID: "n1", Name: "app_default", Driver: "bridge", Scope: "local" }),
    );
    expect(networks[0]).toEqual({
      id: "n1",
      name: "app_default",
      driver: "bridge",
      scope: "local",
    });
  });
});

describe("parseEnvList", () => {
  test("masks credential-shaped keys but keeps the key visible", () => {
    const parsed = parseEnvList([
      "NODE_ENV=production",
      "DATABASE_PASSWORD=hunter2",
      "API_TOKEN=abc",
      "AWS_SECRET_ACCESS_KEY=xyz",
    ]);
    expect(parsed[0]).toEqual({ key: "NODE_ENV", value: "production", secret: false });
    expect(parsed[1].secret).toBe(true);
    expect(parsed[1].value).not.toContain("hunter2");
    expect(parsed[2].secret).toBe(true);
    expect(parsed[3].secret).toBe(true);
  });

  test("handles values containing '=' and empty values", () => {
    const parsed = parseEnvList(["CONNECTION=a=b=c", "EMPTY="]);
    expect(parsed[0].value).toBe("a=b=c");
    // Nothing to hide, so an empty credential-shaped value stays unmasked.
    expect(parsed[1]).toEqual({ key: "EMPTY", value: "", secret: false });
  });
});

describe("mapInspectDocument", () => {
  test("flattens the fields the detail panel renders", () => {
    const detail = mapInspectDocument({
      Id: "8f2c1a9b3d4e",
      Name: "/app-api-1",
      Created: "2026-07-18T09:14:22Z",
      RestartCount: 2,
      State: { Status: "running", StartedAt: "2026-07-20T06:02:10Z" },
      Config: {
        Image: "app-api",
        Cmd: ["node", "dist/server.js"],
        Env: ["NODE_ENV=production", "DB_PASSWORD=secret"],
        Labels: { "com.docker.compose.project": "app" },
      },
      Mounts: [
        {
          Type: "volume",
          Name: "app_pgdata",
          Destination: "/var/lib/postgresql/data",
          RW: false,
        },
      ],
      NetworkSettings: {
        Ports: {
          "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "3000" }],
          "9229/tcp": null,
        },
        Networks: { app_default: {} },
      },
    });

    // Docker's leading slash on names is stripped.
    expect(detail.name).toBe("app-api-1");
    expect(detail.command).toBe("node dist/server.js");
    expect(detail.restartCount).toBe(2);
    expect(detail.networks).toEqual(["app_default"]);
    expect(detail.mounts[0]).toEqual({
      type: "volume",
      source: "app_pgdata",
      destination: "/var/lib/postgresql/data",
      readOnly: true,
    });
    // An unpublished port still lists, with no host binding.
    expect(detail.ports).toContainEqual({ containerPort: "9229/tcp", hostPort: "" });
    expect(detail.ports).toContainEqual({
      containerPort: "3000/tcp",
      hostPort: "0.0.0.0:3000",
    });
    expect(detail.env.find((entry) => entry.key === "DB_PASSWORD")?.secret).toBe(true);
  });

  test("survives a sparse document without throwing", () => {
    const detail = mapInspectDocument({ Id: "abc" });
    expect(detail).toMatchObject({
      id: "abc",
      name: "",
      env: [],
      mounts: [],
      ports: [],
      networks: [],
      labels: {},
      restartCount: 0,
    });
  });
});
