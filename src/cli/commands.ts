import { resolve } from "node:path";
import { ConfigStore, ConfigValidationError } from "../core/config-store.js";
import { GitManager } from "../core/git-manager.js";
import { LogStore } from "../core/log-store.js";
import { ProcessManager } from "../core/process-manager.js";

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

class UsageError extends Error {}

async function runGitCli(
  subcommand: string | undefined,
  args: string[],
  stdout: (line: string) => void,
  configStore: ConfigStore,
): Promise<number> {
  const flags = parseFlags(args);
  const cwd = flags.cwd ?? process.cwd();
  const positional = args.filter((arg, index) => {
    if (!arg.startsWith("--")) {
      const previous = args[index - 1];
      return !(previous?.startsWith("--") && !previous.includes("="));
    }
    return false;
  });
  const git = new GitManager(cwd);

  if (subcommand === "status") {
    const status = await git.status();
    stdout(`Branch\t${status.branch || "(detached)"}`);
    for (const file of status.files) {
      stdout(`${file.index}${file.workingTree}\t${file.path}`);
    }
    return 0;
  }

  if (subcommand === "add-repo") {
    const name = positional[0];
    if (!name) {
      throw new UsageError("repository name is required");
    }
    if (!flags.path) {
      throw new UsageError("--path is required");
    }
    await configStore.registerGitRepository({ name, path: flags.path });
    stdout(`Registered Git repository ${name}`);
    return 0;
  }

  if (subcommand === "select-repo") {
    const name = positional[0];
    if (!name) {
      throw new UsageError("repository name is required");
    }
    await configStore.selectGitRepository(name);
    stdout(`Selected Git repository ${name}`);
    return 0;
  }

  if (subcommand === "diff") {
    stdout(await git.diff(positional[0]));
    return 0;
  }

  if (subcommand === "staged-diff") {
    stdout(await git.stagedDiff(positional[0]));
    return 0;
  }

  if (subcommand === "log") {
    for (const entry of await git.log(flags.limit ? Number(flags.limit) : 10)) {
      stdout(`${entry.hash.slice(0, 8)}\t${entry.subject}`);
    }
    return 0;
  }

  if (subcommand === "branch") {
    for (const branch of await git.branches()) {
      const marker = branch.current ? "*" : " ";
      const scope = branch.remote ? "remote" : "local";
      stdout(`${marker}\t${branch.name}\t${scope}\t${branch.upstream ?? "-"}`);
    }
    return 0;
  }

  if (subcommand === "switch") {
    const name = positional[0];
    if (!name) {
      throw new UsageError("branch name is required");
    }
    stdout(await git.switchBranch(name));
    return 0;
  }

  if (subcommand === "create-branch") {
    const name = positional[0];
    if (!name) {
      throw new UsageError("branch name is required");
    }
    stdout(await git.createBranch(name));
    return 0;
  }

  if (subcommand === "fetch") {
    stdout(await git.fetch());
    return 0;
  }

  if (subcommand === "stage") {
    await git.stage(positional);
    stdout(`Staged ${positional.join(", ")}`);
    return 0;
  }

  if (subcommand === "unstage") {
    await git.unstage(positional);
    stdout(`Unstaged ${positional.join(", ")}`);
    return 0;
  }

  if (subcommand === "commit") {
    const message = flags.message;
    if (!message) {
      throw new UsageError("--message is required");
    }
    stdout(await git.commit(message));
    return 0;
  }

  throw new UsageError(
    "Usage: nomoreide git [status|branch|switch|create-branch|fetch|diff|staged-diff|log|stage|unstage|commit]",
  );
}

function parseFlags(args: string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg?.startsWith("--")) {
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split("=", 2);
    flags[toCamelCase(key)] = inlineValue ?? args[index + 1];
    if (!inlineValue) {
      index += 1;
    }
  }

  return flags;
}

function toCamelCase(input: string): string {
  return input.replace(/-([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}
