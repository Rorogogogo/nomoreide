import { describe, expect, test } from "vitest";
import {
  parseProcessRows,
  summarizeProcessTree,
} from "../src/core/process-tree.js";

describe("process tree", () => {
  test("summarizes descendants by CPU and RSS", () => {
    const rows = parseProcessRows(`
      10 1 0.0 102400 npm run dev
      11 10 1.5 204800 node vite
      12 11 0.2 51200 esbuild
      99 1 8.0 999 unrelated
    `);

    const summary = summarizeProcessTree(rows, 10);

    expect(summary).toMatchObject({
      rootPid: 10,
      processCount: 3,
      cpuPercent: 1.7,
      rssMb: 350,
    });
    expect(summary.processes.map((process) => process.pid)).toEqual([10, 11, 12]);
  });
});
