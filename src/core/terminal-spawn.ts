import type { ServiceDefinition } from "./types.js";
import type { TerminalSpawnOptions } from "./terminal-manager.js";

/**
 * Result of mapping a service to terminal spawn options. `ok: false` carries a
 * user-facing reason (e.g. an SSH service with no host) the route returns as a
 * 400 instead of spawning a broken session.
 */
export type TerminalSpawnResolution =
  | { ok: true; options: TerminalSpawnOptions }
  | { ok: false; error: string };

/**
 * Decide what a "connect" terminal runs for a given service:
 * - **local** → an interactive shell in the service's cwd, with its env merged
 *   over the inherited environment so PATH survives.
 * - **ssh** → `ssh -t <host>` into the remote, cd-ing into the service dir and
 *   launching a login shell there.
 * - **docker-compose** → `docker compose exec <service> sh` from the project dir.
 *
 * The client only ever sends a service *name*; the server derives the command
 * here, so this endpoint can't be coerced into running an arbitrary program.
 */
export function resolveServiceTerminal(
  service: ServiceDefinition,
): TerminalSpawnResolution {
  const kind = service.kind ?? "local";

  if (kind === "ssh") {
    if (!service.host) {
      return { ok: false, error: "SSH service is missing a host." };
    }
    const remote = service.cwd
      ? `cd ${singleQuote(service.cwd)} 2>/dev/null; exec "$SHELL" -l`
      : `exec "$SHELL" -l`;
    return {
      ok: true,
      options: {
        shell: "ssh",
        args: ["-t", service.host, remote],
        label: service.name,
      },
    };
  }

  if (kind === "docker-compose") {
    if (!service.composeService) {
      return { ok: false, error: "Docker service is missing a compose service name." };
    }
    return {
      ok: true,
      options: {
        shell: "docker",
        args: [
          "compose",
          ...(service.composeFile ? ["-f", service.composeFile] : []),
          "exec",
          service.composeService,
          "sh",
        ],
        cwd: service.cwd,
        label: service.name,
      },
    };
  }

  return {
    ok: true,
    options: {
      cwd: service.cwd,
      env: service.env ? { ...process.env, ...service.env } : undefined,
      label: service.name,
    },
  };
}

/** Single-quote a value for safe interpolation into a remote shell command. */
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
