import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ErrorInbox, ErrorInboxContext } from "./error-inbox.js";
import { entriesFromLines, envFilePath, looksSecret, readEnvFile } from "./env-file.js";
import type { ProcessManager } from "./process-manager.js";
import type { ServiceStatus } from "./types.js";

const MASK = "••••••";

export interface ReproBundle {
  incidentId: number;
  markdown: string;
  /** Set when the bundle was also written to disk. */
  savedPath?: string;
}

interface MaskedEnvEntry {
  key: string;
  value: string;
  masked: boolean;
}

interface ReproBundleOptions {
  errorInbox: ErrorInbox;
  manager: ProcessManager;
  /** Directory for saved bundles; defaults to `.nomoreide/repros`. */
  reproDir?: string;
}

/**
 * Assembles a "share my bug" artifact for an Error Inbox incident: the error
 * excerpt, the affected-file diff, recent logs, the service's runtime state,
 * and its `.env` with secrets masked — rendered to one markdown document that
 * can be copied to the clipboard or saved under `.nomoreide/repros/`.
 */
export class ReproBundleBuilder {
  private readonly errorInbox: ErrorInbox;
  private readonly manager: ProcessManager;
  private readonly reproDir: string;

  constructor(options: ReproBundleOptions) {
    this.errorInbox = options.errorInbox;
    this.manager = options.manager;
    this.reproDir = options.reproDir ?? join(process.cwd(), ".nomoreide", "repros");
  }

  async build(id: number, options: { save?: boolean } = {}): Promise<ReproBundle | null> {
    const context = await this.errorInbox.context(id);
    if (!context) return null;

    const status = this.manager.status().services[context.service];
    const env = await readMaskedEnv(context.serviceCwd);
    const markdown = renderBundle(context, status, env);

    let savedPath: string | undefined;
    if (options.save) {
      savedPath = join(this.reproDir, `${stamp()}-incident-${id}.md`);
      await mkdir(this.reproDir, { recursive: true });
      await writeFile(savedPath, markdown);
    }
    return { incidentId: id, markdown, savedPath };
  }
}

async function readMaskedEnv(serviceCwd: string): Promise<MaskedEnvEntry[]> {
  const { exists, lines } = await readEnvFile(envFilePath(serviceCwd));
  if (!exists) return [];
  return entriesFromLines(lines).map((entry) => {
    const masked = looksSecret(entry.key);
    return { key: entry.key, value: masked ? MASK : entry.value, masked };
  });
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function renderBundle(
  context: ErrorInboxContext,
  status: ServiceStatus | undefined,
  env: MaskedEnvEntry[],
): string {
  const { incident, file, diff, recentLogs } = context;
  const parts: string[] = [];

  parts.push(`# Bug report: ${incident.title}`);
  parts.push("");
  const seen = `seen ×${incident.count} · first ${incident.firstSeen} · last ${incident.lastSeen}`;
  parts.push(`**Service:** \`${context.service}\` · **Level:** ${incident.level} · ${seen}`);

  parts.push("");
  parts.push("## Error");
  parts.push("```");
  parts.push(...incident.logExcerpt);
  parts.push("```");

  if (file) {
    parts.push("");
    parts.push(`**Affected file:** \`${file}\`${incident.line ? ` (line ${incident.line})` : ""}`);
  }
  if (diff.trim()) {
    parts.push("");
    parts.push("## Diff of the affected file");
    parts.push("```diff");
    parts.push(diff.trimEnd());
    parts.push("```");
  }
  if (recentLogs.length) {
    parts.push("");
    parts.push(`## Last ${recentLogs.length} log lines`);
    parts.push("```");
    parts.push(...recentLogs);
    parts.push("```");
  }

  parts.push("");
  parts.push("## Service state");
  parts.push(...renderServiceState(context.service, status));

  parts.push("");
  parts.push("## Environment (`.env`, secrets masked)");
  if (env.length) {
    parts.push("");
    parts.push("| Key | Value |");
    parts.push("| --- | --- |");
    for (const entry of env) {
      parts.push(`| \`${entry.key}\` | ${entry.masked ? MASK : `\`${entry.value}\``} |`);
    }
  } else {
    parts.push("");
    parts.push("_No `.env` file found for this service._");
  }

  return parts.join("\n");
}

function renderServiceState(service: string, status: ServiceStatus | undefined): string[] {
  if (!status) {
    return [`- **${service}** is not currently managed (no run state).`];
  }
  const lines = [`- **State:** ${status.state}`];
  if (status.kind) lines.push(`- **Kind:** ${status.kind}`);
  if (status.pid) lines.push(`- **PID:** ${status.pid}`);
  if (status.url) lines.push(`- **URL:** ${status.url}`);
  if (status.startedAt) lines.push(`- **Started:** ${status.startedAt}`);
  if (status.exitedAt) lines.push(`- **Exited:** ${status.exitedAt}`);
  if (status.exitCode != null) lines.push(`- **Exit code:** ${status.exitCode}`);
  return lines;
}
