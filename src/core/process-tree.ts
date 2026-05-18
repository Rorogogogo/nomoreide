import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessRow {
  pid: number;
  ppid: number;
  cpuPercent: number;
  rssMb: number;
  command: string;
}

export interface ProcessTreeSummary {
  rootPid: number;
  processCount: number;
  cpuPercent: number;
  rssMb: number;
  processes: ProcessRow[];
}

export function parseProcessRows(raw: string): ProcessRow[] {
  return raw
    .trim()
    .split(/\n/)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
      if (!match) return undefined;

      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        cpuPercent: Number(match[3]),
        rssMb: Number(match[4]) / 1024,
        command: match[5],
      };
    })
    .filter((row): row is ProcessRow => Boolean(row));
}

export function summarizeProcessTree(
  rows: ProcessRow[],
  rootPid: number,
): ProcessTreeSummary {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }

  const processes: ProcessRow[] = [];
  const seen = new Set<number>();
  const stack = [rootPid];

  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);

    const row = rows.find((item) => item.pid === pid);
    if (row) {
      processes.push(row);
    }

    for (const child of byParent.get(pid) ?? []) {
      stack.push(child.pid);
    }
  }

  return {
    rootPid,
    processCount: processes.length,
    cpuPercent: roundOne(processes.reduce((sum, row) => sum + row.cpuPercent, 0)),
    rssMb: roundOne(processes.reduce((sum, row) => sum + row.rssMb, 0)),
    processes,
  };
}

export async function readProcessTree(
  rootPid: number,
): Promise<ProcessTreeSummary> {
  const { stdout } = await execFileAsync("ps", [
    "-ax",
    "-o",
    "pid=,ppid=,%cpu=,rss=,command=",
  ]);

  return summarizeProcessTree(parseProcessRows(stdout), rootPid);
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}
