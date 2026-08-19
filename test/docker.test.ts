import { describe, expect, test } from "vitest";
import {
  dockerReadDirectoryArgs,
  dockerReadFileArgs,
  dockerDesktopInstallUrl,
  dockerDesktopLookupCommand,
  dockerDesktopStartCommand,
  mergeTimestampedLogLines,
  parseDockerPsLines,
} from "../src/core/docker.js";

describe("parseDockerPsLines", () => {
  test("parses containers and splits compose labels into project/service", () => {
    const stdout = [
      JSON.stringify({
        ID: "abc123",
        Names: "myapp-api-1",
        Image: "myapp-api",
        State: "running",
        Status: "Up 2 hours",
        Ports: "0.0.0.0:3000->3000/tcp",
        CreatedAt: "2026-07-01 10:00:00 +0000 UTC",
        Labels: "com.docker.compose.project=myapp,com.docker.compose.service=api,other=x",
      }),
      JSON.stringify({
        ID: "def456",
        Names: "standalone-redis",
        Image: "redis:7",
        State: "exited",
        Status: "Exited (0) 3 days ago",
        Ports: "",
        Labels: "",
      }),
    ].join("\n");

    expect(parseDockerPsLines(stdout)).toEqual([
      {
        id: "abc123",
        name: "myapp-api-1",
        image: "myapp-api",
        state: "running",
        status: "Up 2 hours",
        ports: "0.0.0.0:3000->3000/tcp",
        createdAt: "2026-07-01 10:00:00 +0000 UTC",
        project: "myapp",
        service: "api",
      },
      {
        id: "def456",
        name: "standalone-redis",
        image: "redis:7",
        state: "exited",
        status: "Exited (0) 3 days ago",
        ports: "",
        createdAt: undefined,
        project: undefined,
        service: undefined,
      },
    ]);
  });

  test("ignores blank lines and lines that aren't valid JSON", () => {
    const stdout = "\n  \nnot json\n" + JSON.stringify({ ID: "abc123" }) + "\n";
    expect(parseDockerPsLines(stdout)).toEqual([
      {
        id: "abc123",
        name: "abc123",
        image: "",
        state: "unknown",
        status: "",
        ports: "",
        createdAt: undefined,
        project: undefined,
        service: undefined,
      },
    ]);
  });

  test("drops lines with no container ID", () => {
    expect(parseDockerPsLines(JSON.stringify({ Names: "no-id" }))).toEqual([]);
  });
});

describe("mergeTimestampedLogLines", () => {
  test("interleaves stdout and stderr lines in chronological order", () => {
    const stdout = [
      "2026-07-01T10:00:00.000000000Z stdout line 1",
      "2026-07-01T10:00:02.000000000Z stdout line 2",
    ].join("\n");
    const stderr = "2026-07-01T10:00:01.000000000Z stderr line 1";

    expect(mergeTimestampedLogLines(stdout, stderr)).toBe(
      [
        "2026-07-01T10:00:00.000000000Z stdout line 1",
        "2026-07-01T10:00:01.000000000Z stderr line 1",
        "2026-07-01T10:00:02.000000000Z stdout line 2",
      ].join("\n"),
    );
  });

  test("drops blank lines from either stream", () => {
    expect(mergeTimestampedLogLines("\n\n", "\n")).toBe("");
  });
});

describe("Docker file explorer argv", () => {
  test("keeps unusual container paths in one positional argument", () => {
    const path = "/app/a folder/it's-$HOME";

    const args = dockerReadDirectoryArgs("api-1", path);

    expect(args.slice(0, 4)).toEqual(["exec", "api-1", "sh", "-c"]);
    expect(args.at(-2)).toBe("nomoreide");
    expect(args.at(-1)).toBe(path);
  });

  test("requires absolute paths when reading file contents", () => {
    expect(() => dockerReadFileArgs("api-1", "etc/passwd")).toThrow(
      "must be absolute",
    );
  });
});

describe("Docker Desktop launcher", () => {
  test("uses the fixed macOS application launch command", () => {
    expect(dockerDesktopStartCommand("darwin")).toEqual({
      file: "open",
      args: ["-a", "Docker"],
    });
  });

  test("does not claim automatic start support on other platforms", () => {
    expect(dockerDesktopStartCommand("linux")).toBeNull();
    expect(dockerDesktopStartCommand("win32")).toBeNull();
  });

  test("looks up the app without launching it and links official macOS instructions", () => {
    expect(dockerDesktopLookupCommand("darwin")).toEqual({
      file: "open",
      args: ["-Ra", "Docker"],
    });
    expect(dockerDesktopInstallUrl("darwin")).toBe(
      "https://docs.docker.com/desktop/setup/install/mac-install/",
    );
    expect(dockerDesktopInstallUrl("linux")).toBeUndefined();
  });
});
