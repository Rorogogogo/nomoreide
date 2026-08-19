export interface SshCommandInput {
  host: string;
  cwd: string;
  command: string;
  env?: Record<string, string>;
}

export function createSshCommand(input: SshCommandInput): [string, string[]] {
  validateSshInput(input);
  const envPrefix = formatEnvPrefix(input.env);
  const remote = `cd ${shellEscape(input.cwd)} && ${envPrefix}exec ${input.command}`;
  return ["ssh", [input.host, remote]];
}

function validateSshInput(input: SshCommandInput): void {
  if (!input.host.trim()) throw new Error("SSH host is required.");
  if (!input.cwd.trim()) throw new Error("SSH cwd is required.");
  if (!input.command.trim()) throw new Error("SSH command is required.");
  if (input.command.includes("\0")) {
    throw new Error("SSH command contains invalid null byte.");
  }
  for (const key of Object.keys(input.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
  }
}

function formatEnvPrefix(env?: Record<string, string>): string {
  if (!env) return "";
  const entries = Object.entries(env);
  if (entries.length === 0) return "";
  return `${entries
    .map(([key, value]) => `${key}=${shellEscape(value)}`)
    .join(" ")} `;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
