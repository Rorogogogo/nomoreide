import type { LogSourceDefinition, ServiceDefinition } from "./types.js";

/**
 * Derives a queryable log source from a service that streams its logs over ssh
 * (journald or docker). This lets a managed service's log view re-query the host
 * for full history — search, time range, paging — instead of being limited to
 * its live in-memory buffer. Returns null when the service has no remote,
 * queryable backend (e.g. a local `npm run dev`).
 */
export function deriveServiceLogSource(service: ServiceDefinition): LogSourceDefinition | null {
  if (service.kind !== "ssh" || !service.host || !service.command) return null;

  const unit = matchJournaldUnit(service.command);
  if (unit) {
    return { name: service.name, kind: "command", driver: "journald", unit, host: service.host };
  }
  const container = matchDockerContainer(service.command);
  if (container) {
    return { name: service.name, kind: "command", driver: "docker", container, host: service.host };
  }
  return null;
}

/** Pulls the unit out of a `journalctl … -u <unit>` / `--unit <unit>` command. */
function matchJournaldUnit(command: string): string | null {
  if (!/\bjournalctl\b/.test(command)) return null;
  const match = command.match(/(?:-u|--unit)[=\s]+(\S+)/);
  return match ? stripQuotes(match[1]) : null;
}

/** Pulls the container out of a `docker logs [flags] <container>` command. */
function matchDockerContainer(command: string): string | null {
  const parts = command.split(/\bdocker\s+logs\b/);
  if (parts.length < 2) return null;
  const tokens = parts[1].trim().split(/\s+/).filter(Boolean);
  const flagsTakingValue = new Set(["--tail", "--since", "--until", "-n"]);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-")) {
      if (flagsTakingValue.has(token)) i++; // skip the flag's value
      continue;
    }
    return stripQuotes(token); // first bare token is the container
  }
  return null;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}
