import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  NOMOREIDE_TOOL_DOMAINS,
  NOMOREIDE_TOOL_NAMES,
} from "../src/mcp/tools/index.js";
import {
  captureMcpContract,
  normalizeMcpContract,
} from "./support/mcp-contract.js";

const root = resolve(import.meta.dirname, "..");
const fixtureDir = join(root, "test", "fixtures");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function readFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(fixtureDir, name), "utf8"));
}

describe("MCP compatibility contract", () => {
  test("matches the TypeScript server over stdio", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "nomoreide-mcp-contract-test-"));
    tempDirs.push(tempHome);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const actual = await captureMcpContract({
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts", "mcp"],
      cwd: root,
      env: {
        ...env,
        HOME: tempHome,
        XDG_CONFIG_HOME: join(tempHome, ".config"),
        NOMOREIDE_AUTO_UI: "0",
      },
    });

    expect(actual).toEqual(await readFixture("mcp-contract-v1.json"));
  });

  test("keeps the 90-tool ownership manifest synchronized", async () => {
    const expected = await readFixture("mcp-tool-manifest-v1.json");
    const actual = {
      manifestVersion: 1,
      total: NOMOREIDE_TOOL_NAMES.length,
      domains: Object.entries(NOMOREIDE_TOOL_DOMAINS).map(([owner, tools]) => ({
        owner,
        count: tools.length,
        tools,
      })),
    };

    expect(actual).toEqual(expected);
    expect(NOMOREIDE_TOOL_NAMES).toHaveLength(90);
  });

  test("normalizes only explicitly dynamic parity values", () => {
    expect(
      normalizeMcpContract(
        {
          pid: 1234,
          port: 4317,
          id: 42,
          startedAt: "2026-08-20T01:02:03.456Z",
          value:
            "/tmp/reference/run 123e4567-e89b-12d3-a456-426614174000 at 2026-08-20T01:02:03Z",
        },
        { temporaryPaths: ["/tmp/reference"] },
      ),
    ).toEqual({
      pid: "<pid>",
      port: "<port>",
      id: 42,
      startedAt: "<startedAt>",
      value: "<temporary-path>/run <uuid> at <timestamp>",
    });
  });
});
