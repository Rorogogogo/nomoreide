import {
  ConfigStore,
  ConfigValidationError,
  defaultGlobalConfigPath,
} from "../core/config-store.js";
import {
  createDaemonConnection,
  type DaemonConnection,
} from "../core/daemon-client.js";
import { runAgentsCli } from "./agents.js";
import { UsageError } from "./errors.js";
import { parseFlags } from "./flags.js";
import { runGitCli } from "./git.js";
import { runProfileCli } from "./profile.js";

const USAGE =
  "Usage: nomoreide [mcp|setup|tui|web|daemon|git|agents|profile|list|logs|start|stop|restart|add]";

const MCP_SETUP_LINES = [
  "NoMoreIDE MCP setup",
  "",
  "Claude Code:",
  "  claude mcp add --transport stdio nomoreide -- npx -y nomoreide",
  "",
  "Codex CLI:",
  "  codex mcp add nomoreide -- npx -y nomoreide",
  "",
  "Gemini CLI:",
  "  Add to ~/.gemini/settings.json:",
  '  {"mcpServers":{"nomoreide":{"command":"npx","args":["-y","nomoreide"]}}}',
  "",
  "Then verify inside your agent:",
  "  /mcp",
  "",
  "Prompt to paste into your agent:",
  "  Please set up NoMoreIDE as a local MCP server for this agent. Register a server named nomoreide that runs npx -y nomoreide. After adding it, tell me how to verify it with /mcp.",
];

export interface CliOptions {
  configPath?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Injectable for tests; defaults to the machine-global daemon. */
  daemon?: DaemonConnection;
}

export async function runCli(
  args: string[],
  options: CliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const configStore = new ConfigStore(
    options.configPath ?? defaultGlobalConfigPath(),
  );
  // Runtime commands (start/stop/restart/logs) talk to the shared daemon so
  // services outlive this CLI invocation and are visible to every session.
  const daemon = options.daemon ?? createDaemonConnection();

  try {
    const [command, subcommand, ...rest] = args;

    if (command === "setup") {
      for (const line of MCP_SETUP_LINES) {
        stdout(line);
      }
      return 0;
    }

    if (command === "git") {
      return await runGitCli(subcommand, rest, stdout, configStore);
    }

    if (command === "agents") {
      return await runAgentsCli(subcommand, rest, stdout);
    }

    if (command === "profile") {
      return await runProfileCli(subcommand, rest, stdout);
    }

    if (command === "add" && subcommand === "service") {
      const name = rest[0];
      const flags = parseFlags(rest.slice(1));
      if (!name) {
        throw new UsageError("service name is required");
      }

      const kind = (flags.kind ?? "local") as "local" | "docker-compose" | "ssh";
      const port = flags.port ? Number(flags.port) : undefined;
      const description = flags.description;

      if (kind === "docker-compose") {
        if (!flags.composeService) {
          throw new UsageError("--compose-service is required");
        }
        await configStore.registerService({
          name,
          kind: "docker-compose",
          cwd: flags.cwd ?? process.cwd(),
          composeFile: flags.composeFile,
          composeService: flags.composeService,
          port,
          description,
        });
      } else if (kind === "ssh") {
        if (!flags.host) throw new UsageError("--host is required");
        if (!flags.command) throw new UsageError("--command is required");
        if (!flags.cwd) throw new UsageError("--cwd is required");
        await configStore.registerService({
          name,
          kind: "ssh",
          host: flags.host,
          cwd: flags.cwd,
          command: flags.command,
          port,
          description,
        });
      } else {
        if (!flags.command) throw new UsageError("--command is required");
        await configStore.registerService({
          name,
          command: flags.command,
          cwd: flags.cwd ?? process.cwd(),
          port,
          description,
        });
      }
      stdout(`Registered service ${name}`);
      return 0;
    }

    if (command === "add" && subcommand === "bundle") {
      const [name, ...services] = rest;
      if (!name) {
        throw new UsageError("bundle name is required");
      }
      if (services.length === 0) {
        throw new UsageError("at least one service is required");
      }

      await configStore.registerBundle({ name, services });
      stdout(`Registered bundle ${name}`);
      return 0;
    }

    if (command === "list") {
      const config = await configStore.load();
      stdout("Services");
      for (const service of config.services) {
        stdout(
          `${service.name}\t${service.port ?? "-"}\t${service.command}\t${service.cwd}`,
        );
      }
      stdout("Bundles");
      for (const bundle of config.bundles) {
        stdout(`${bundle.name}\t${bundle.services.join(",")}`);
      }
      return 0;
    }

    if (command === "logs") {
      const name = subcommand;
      if (!name) {
        throw new UsageError("service name is required");
      }
      const client = await daemon.client();
      for (const entry of await client.logs(name, 200)) {
        stdout(`${entry.timestamp}\t${entry.stream}\t${entry.text}`);
      }
      return 0;
    }

    if (["start", "stop", "restart"].includes(command ?? "")) {
      const name = subcommand;
      if (!name) {
        throw new UsageError("service or bundle name is required");
      }
      const config = await configStore.load();
      const isBundle = config.bundles.some((bundle) => bundle.name === name);
      const client = await daemon.client();
      const result =
        command === "start"
          ? isBundle
            ? await client.startBundle(name)
            : await client.startService(name)
          : command === "stop"
            ? isBundle
              ? await client.stopBundle(name)
              : await client.stopService(name)
            : await client.restartService(name);

      stdout(JSON.stringify(result, null, 2));
      return 0;
    }

    throw new UsageError(USAGE);
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return error instanceof UsageError || error instanceof ConfigValidationError ? 1 : 2;
  }
}
