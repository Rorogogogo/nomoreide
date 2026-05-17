import { resolve } from "node:path";
import { ConfigStore, ConfigValidationError } from "../core/config-store.js";
import { LogStore } from "../core/log-store.js";
import { ProcessManager } from "../core/process-manager.js";
import { UsageError } from "./errors.js";
import { parseFlags } from "./flags.js";
import { runGitCli } from "./git.js";

export interface CliOptions {
  configPath?: string;
  logDir?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function runCli(
  args: string[],
  options: CliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const configStore = new ConfigStore(
    options.configPath ?? resolve(process.cwd(), "nomoreide.config.json"),
  );
  const logStore = new LogStore({
    baseDir: options.logDir ?? resolve(process.cwd(), ".nomoreide/logs"),
  });
  const manager = new ProcessManager({ configStore, logStore });

  try {
    const [command, subcommand, ...rest] = args;

    if (command === "git") {
      return await runGitCli(subcommand, rest, stdout, configStore);
    }

    if (command === "add" && subcommand === "service") {
      const name = rest[0];
      const flags = parseFlags(rest.slice(1));
      if (!name) {
        throw new UsageError("service name is required");
      }
      if (!flags.command) {
        throw new UsageError("--command is required");
      }

      await configStore.registerService({
        name,
        command: flags.command,
        cwd: flags.cwd ?? process.cwd(),
        port: flags.port ? Number(flags.port) : undefined,
        description: flags.description,
      });
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
      for (const entry of logStore.read(name, 200)) {
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
      const result =
        command === "start"
          ? isBundle
            ? await manager.startBundle(name)
            : await manager.startService(name)
          : command === "stop"
            ? isBundle
              ? await manager.stopBundle(name)
              : await manager.stopService(name)
            : await manager.restartService(name);

      stdout(JSON.stringify(result, null, 2));
      return 0;
    }

    throw new UsageError(
      "Usage: nomoreide [mcp|tui|web|git|list|logs|start|stop|restart|add]",
    );
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return error instanceof UsageError || error instanceof ConfigValidationError ? 1 : 2;
  }
}
