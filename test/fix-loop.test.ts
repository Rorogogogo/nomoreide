import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentSessionStore } from "../src/core/agent-sessions.js";
import { ConfigStore } from "../src/core/config-store.js";
import { ErrorInbox } from "../src/core/error-inbox.js";
import { FixLoop } from "../src/core/fix-loop.js";
import { LogStore } from "../src/core/log-store.js";
import { ProcessManager } from "../src/core/process-manager.js";
import { ReproBundleBuilder } from "../src/core/repro-bundle.js";
import type { Snapshot } from "../src/core/snapshot-manager.js";

let tempDir: string;
let logs: LogStore;
let configStore: ConfigStore;
let inbox: ErrorInbox;
let manager: ProcessManager;
let reproBundle: ReproBundleBuilder;
let sessions: AgentSessionStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-fix-"));
  logs = new LogStore({ baseDir: join(tempDir, "logs"), maxLinesPerService: 100 });
  configStore = new ConfigStore(join(tempDir, "config.json"));
  inbox = new ErrorInbox({ logStore: logs, configStore, cwd: tempDir });
  manager = new ProcessManager({ configStore, logStore: logs });
  reproBundle = new ReproBundleBuilder({
    errorInbox: inbox,
    manager,
    reproDir: join(tempDir, "repros"),
  });
  sessions = new AgentSessionStore(join(tempDir, "agent-sessions.json"));
});

afterEach(async () => {
  inbox.dispose();
  await rm(tempDir, { recursive: true, force: true });
});

/** A fake snapshot manager so the test doesn't need a real git repo. */
function fakeSnapshots(sha: string) {
  const calls: string[] = [];
  return {
    calls,
    snapshot: async (label: string): Promise<Snapshot> => {
      calls.push(label);
      return { sha, ref: `refs/nomoreide/snapshots/${sha}`, label, createdAt: "now" };
    },
    prune: async () => 0,
  };
}

describe("FixLoop", () => {
  test("returns null for an unknown incident", async () => {
    const loop = new FixLoop({
      reproBundle,
      agentSessions: sessions,
      resolveRepoPath: async () => tempDir,
    });
    expect(await loop.prepare(999)).toBeNull();
  });

  test("snapshots, records a session, and returns a fix prompt", async () => {
    await configStore.registerService({ name: "api", command: "sleep 1", cwd: tempDir });
    await writeFile(join(tempDir, ".env"), "API_SECRET=hunter2\n");
    await logs.append("api", "stderr", "Error: boom");
    const incident = inbox.list()[0];

    const snaps = fakeSnapshots("abc1234");
    const loop = new FixLoop({
      reproBundle,
      agentSessions: sessions,
      resolveRepoPath: async () => tempDir,
      snapshotManagerFor: () => snaps,
    });

    const prep = await loop.prepare(incident.id);
    expect(prep).not.toBeNull();
    expect(prep?.snapshotSha).toBe("abc1234");
    expect(prep?.repoPath).toBe(tempDir);
    // The repro bundle markdown is wrapped in a fix instruction.
    expect(prep?.prompt).toContain("apply the smallest change");
    expect(prep?.prompt).toContain("# Bug report: Error: boom");
    expect(snaps.calls[0]).toContain(`fix incident ${incident.id}`);

    // The session is persisted and pinned to the snapshot, so Agent → Changes
    // can surface it with a restore button.
    const recorded = await sessions.get(prep?.sessionId ?? "");
    expect(recorded?.snapshotSha).toBe("abc1234");
    expect(recorded?.repoPath).toBe(tempDir);
  });

  test("still records a session (without snapshot) when the repo isn't git", async () => {
    await logs.append("api", "stderr", "Error: boom");
    const incident = inbox.list()[0];

    const loop = new FixLoop({
      reproBundle,
      agentSessions: sessions,
      resolveRepoPath: async () => tempDir,
      snapshotManagerFor: () => ({
        snapshot: async () => {
          throw new Error("not a git repository");
        },
        prune: async () => 0,
      }),
    });

    const prep = await loop.prepare(incident.id);
    expect(prep).not.toBeNull();
    expect(prep?.snapshotSha).toBeUndefined();
    const recorded = await sessions.get(prep?.sessionId ?? "");
    expect(recorded).toBeDefined();
    expect(recorded?.snapshotSha).toBeUndefined();
  });
});
