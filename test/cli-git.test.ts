import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "../src/cli/commands.js";

const execFileAsync = promisify(execFile);

let repoDir: string;
let output: string[];
let errors: string[];

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "nomoreide-cli-git-"));
  output = [];
  errors = [];
  await git(["init"]);
  await git(["config", "user.email", "nomoreide@example.test"]);
  await git(["config", "user.name", "NoMoreIDE Test"]);
  await writeFile(join(repoDir, "README.md"), "initial\n");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "initial commit"]);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("CLI git commands", () => {
  test("prints git status and diff", async () => {
    await writeFile(join(repoDir, "README.md"), "changed\n");

    await runCli(["git", "status", "--cwd", repoDir], cliOptions());
    await runCli(["git", "diff", "--cwd", repoDir], cliOptions());

    const text = output.join("\n");
    expect(text).toContain("Branch");
    expect(text).toContain("README.md");
    expect(text).toContain("-initial");
    expect(text).toContain("+changed");
  });

  test("stages and commits explicit files", async () => {
    await writeFile(join(repoDir, "feature.txt"), "hello\n");

    await runCli(["git", "stage", "--cwd", repoDir, "feature.txt"], cliOptions());
    const exitCode = await runCli(
      ["git", "commit", "--cwd", repoDir, "--message", "add feature"],
      cliOptions(),
    );

    expect(exitCode).toBe(0);
    await runCli(["git", "log", "--cwd", repoDir], cliOptions());
    expect(output.join("\n")).toContain("add feature");
  });

  test("registers and selects git repositories", async () => {
    const configPath = join(repoDir, "nomoreide.config.json");

    await runCli(
      ["git", "add-repo", "app", "--path", repoDir],
      { ...cliOptions(), configPath },
    );
    const exitCode = await runCli(
      ["git", "select-repo", "app"],
      { ...cliOptions(), configPath },
    );

    expect(exitCode).toBe(0);
    expect(output.join("\n")).toContain("Registered Git repository app");
    expect(output.join("\n")).toContain("Selected Git repository app");
  });
});

function cliOptions() {
  return {
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errors.push(line),
  };
}

async function git(args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repoDir });
}
