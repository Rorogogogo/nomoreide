import type { ConfigStore } from "../core/config-store.js";
import { GitManager } from "../core/git-manager.js";
import { UsageError } from "./errors.js";
import { parseFlags } from "./flags.js";

export async function runGitCli(
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
