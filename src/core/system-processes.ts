import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProcessProtection =
  | "managed"
  | "permission"
  | "system"
  | "this-app";

export interface SystemProcess {
  pid: number;
  ppid: number;
  uid: number;
  user: string;
  cpuPercent: number;
  rssMb: number;
  command: string;
  managedService?: string;
  canTerminate: boolean;
  protection?: ProcessProtection;
}

export interface ManagedProcessRoot {
  pid: number;
  service: string;
}

export function parseSystemProcesses(raw: string): SystemProcess[] {
  return raw
    .trim()
    .split(/\n/)
    .map((line) => {
      const match = line
        .trim()
        .match(/^(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
      if (!match) return undefined;
      return {
        uid: Number(match[1]),
        user: match[2],
        pid: Number(match[3]),
        ppid: Number(match[4]),
        cpuPercent: Number(match[5]),
        rssMb: Number(match[6]) / 1024,
        command: match[7],
        canTerminate: false,
      };
    })
    .filter((row): row is SystemProcess => Boolean(row));
}

export async function readSystemProcesses(): Promise<SystemProcess[]> {
  const { stdout } = await execFileAsync("ps", [
    "-ax",
    "-o",
    "uid=,user=,pid=,ppid=,%cpu=,rss=,command=",
  ]);
  return parseSystemProcesses(stdout);
}

export function classifySystemProcesses(
  rows: SystemProcess[],
  managedRoots: ManagedProcessRoot[],
  options: { currentPid?: number; currentUid?: number } = {},
): SystemProcess[] {
  const currentPid = options.currentPid ?? process.pid;
  const currentUid = options.currentUid ?? process.getuid?.();
  const appTree = appTreePids(rows, currentPid);
  const managed = managedServices(rows, managedRoots);

  return rows.map((row) => {
    const managedService = managed.get(row.pid);
    const protection: ProcessProtection | undefined = managedService
      ? "managed"
      : row.pid <= 1
        ? "system"
        : appTree.has(row.pid)
          ? "this-app"
          : currentUid === undefined || row.uid !== currentUid
            ? "permission"
            : undefined;
    return {
      ...row,
      managedService,
      canTerminate: protection === undefined,
      protection,
    };
  });
}

export async function terminateSystemProcess(
  pid: number,
  expectedCommand: string,
  managedRoots: ManagedProcessRoot[],
  options: {
    currentPid?: number;
    currentUid?: number;
    read?: () => Promise<SystemProcess[]>;
    signal?: (pid: number) => void;
  } = {},
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error("Invalid process id.");
  }
  const rows = await (options.read ?? readSystemProcesses)();
  const target = classifySystemProcesses(rows, managedRoots, options).find(
    (row) => row.pid === pid,
  );
  if (!target) throw new Error(`Process ${pid} is no longer running.`);
  if (target.command !== expectedCommand) {
    throw new Error(`Process ${pid} changed before it could be terminated.`);
  }
  if (!target.canTerminate) {
    throw new Error(`Process ${pid} is protected (${target.protection}).`);
  }
  (options.signal ?? ((targetPid) => process.kill(targetPid, "SIGTERM")))(pid);
}

function appTreePids(rows: SystemProcess[], pid: number): Set<number> {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const related = new Set<number>([pid]);
  let parent = byPid.get(pid)?.ppid;
  while (parent && parent > 0 && !related.has(parent)) {
    related.add(parent);
    parent = byPid.get(parent)?.ppid;
  }

  const children = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row.pid);
    children.set(row.ppid, siblings);
  }
  const stack = [...(children.get(pid) ?? [])];
  while (stack.length > 0) {
    const child = stack.pop();
    if (child === undefined || related.has(child)) continue;
    related.add(child);
    stack.push(...(children.get(child) ?? []));
  }
  return related;
}

function managedServices(
  rows: SystemProcess[],
  roots: ManagedProcessRoot[],
): Map<number, string> {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row.pid);
    children.set(row.ppid, siblings);
  }
  const result = new Map<number, string>();
  for (const root of roots) {
    const stack = [root.pid];
    while (stack.length > 0) {
      const pid = stack.pop();
      if (pid === undefined || result.has(pid)) continue;
      result.set(pid, root.service);
      stack.push(...(children.get(pid) ?? []));
    }
  }
  return result;
}
