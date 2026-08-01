import { describe, expect, test, vi } from "vitest";
import {
  classifySystemProcesses,
  parseSystemProcesses,
  terminateSystemProcess,
} from "../src/core/system-processes.js";

const rows = parseSystemProcesses(`
  501 alice 10 1 0.0 1024 nomoreide daemon
  501 alice 11 10 1.5 2048 node managed-child.js
  501 alice 20 1 8.0 4096 Safari
  501 alice 21 20 2.0 1024 Safari Helper
  502 bob 30 1 3.0 1024 worker
  0 root 1 0 0.0 512 launchd
`);

describe("system processes", () => {
  test("parses and classifies managed, external, app, and foreign processes", () => {
    const classified = classifySystemProcesses(
      rows,
      [{ pid: 10, service: "web" }],
      { currentPid: 20, currentUid: 501 },
    );

    expect(classified.find((row) => row.pid === 11)).toMatchObject({
      managedService: "web",
      canTerminate: false,
      protection: "managed",
      rssMb: 2,
    });
    expect(classified.find((row) => row.pid === 20)).toMatchObject({
      canTerminate: false,
      protection: "this-app",
    });
    expect(classified.find((row) => row.pid === 21)).toMatchObject({
      canTerminate: false,
      protection: "this-app",
    });
    expect(classified.find((row) => row.pid === 30)).toMatchObject({
      canTerminate: false,
      protection: "permission",
    });
  });

  test("revalidates identity and protection before sending SIGTERM", async () => {
    const signal = vi.fn();
    await terminateSystemProcess(20, "Safari", [], {
      currentPid: 99,
      currentUid: 501,
      read: async () => rows,
      signal,
    });
    expect(signal).toHaveBeenCalledWith(20);

    await expect(
      terminateSystemProcess(20, "different command", [], {
        currentPid: 99,
        currentUid: 501,
        read: async () => rows,
        signal,
      }),
    ).rejects.toThrow("changed");
    await expect(
      terminateSystemProcess(11, "node managed-child.js", [{ pid: 10, service: "web" }], {
        currentPid: 99,
        currentUid: 501,
        read: async () => rows,
        signal,
      }),
    ).rejects.toThrow("protected (managed)");
  });
});
