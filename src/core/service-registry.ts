import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ServiceKind } from "./types.js";

/**
 * One running service spawned by some session's ProcessManager. Persisted so
 * every session (and the shared web UI process) sees the same set and can
 * adopt/stop a service it did not spawn itself.
 *
 * Only `local`/`ssh` services are tracked here — they are the ones spawned with
 * a real OS pid via `spawn(... detached)`, so liveness can be probed with
 * `process.kill(pid, 0)`. docker-compose services dedupe through compose itself.
 */
export interface ServiceRegistryEntry {
  name: string;
  /** pid of the spawned process (also the process-group leader: detached spawn). */
  pid: number;
  /** process-group id, equal to `pid` for detached spawns; used for group signals. */
  pgid?: number;
  port?: number;
  url?: string;
  kind: ServiceKind;
  host?: string;
  startedAt: string;
  /** pid of the manager process that spawned it (for owner-scoped cleanup). */
  ownerPid: number;
}

type RegistryFile = Record<string, ServiceRegistryEntry>;

/**
 * Shared, project-local view of running services, persisted at
 * `.nomoreide/runtime.json`. Reads never mutate the file; mutations rewrite it
 * atomically (temp + rename) and drop any entries whose pid has died, so stale
 * entries from a crashed session self-heal on the next write.
 */
export class ServiceRegistry {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  list(): ServiceRegistryEntry[] {
    return Object.values(this.read()).filter((entry) => isPidAlive(entry.pid));
  }

  get(name: string): ServiceRegistryEntry | null {
    const entry = this.read()[name];
    return entry && isPidAlive(entry.pid) ? entry : null;
  }

  record(entry: ServiceRegistryEntry): void {
    const all = this.pruned();
    all[entry.name] = entry;
    this.write(all);
  }

  update(name: string, patch: Partial<ServiceRegistryEntry>): void {
    const all = this.pruned();
    const existing = all[name];
    if (!existing) return;
    all[name] = { ...existing, ...patch };
    this.write(all);
  }

  remove(name: string): void {
    const all = this.pruned();
    if (name in all) {
      delete all[name];
    }
    this.write(all);
  }

  removeOwnedBy(ownerPid: number): void {
    const all = this.read();
    let changed = false;
    for (const [name, entry] of Object.entries(all)) {
      if (entry.ownerPid === ownerPid || !isPidAlive(entry.pid)) {
        delete all[name];
        changed = true;
      }
    }
    if (changed) this.write(all);
  }

  private pruned(): RegistryFile {
    const all = this.read();
    for (const [name, entry] of Object.entries(all)) {
      if (!isPidAlive(entry.pid)) delete all[name];
    }
    return all;
  }

  private read(): RegistryFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object") return {};
      return parsed as RegistryFile;
    } catch {
      return {};
    }
  }

  private write(all: RegistryFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}

/**
 * The shared registry lives next to the project logs: `.nomoreide/runtime.json`.
 * `logDir` is `.nomoreide/logs`, so its parent is the `.nomoreide` root.
 */
export function defaultRuntimeRegistryPath(logDir: string): string {
  return resolve(dirname(resolve(logDir)), "runtime.json");
}

/** `true` while the pid exists (including when owned by another user — EPERM). */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
