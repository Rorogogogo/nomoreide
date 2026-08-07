import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import {
  commitEmail,
  httpsRemoteHost,
  identityEnv,
  resolveGitIdentityState,
  resolvePushCredential,
} from "../src/core/git-identity.js";
import { GitManager } from "../src/core/git-manager.js";
import type { GitRepositoryDefinition } from "../src/core/types.js";

const execFileAsync = promisify(execFile);

let repoDir: string;
let configPath: string;
let store: ConfigStore;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "nomoreide-identity-"));
  configPath = join(repoDir, "nomoreide.config.json");
  store = new ConfigStore(configPath);
  await execGit(["init"]);
  await execGit(["config", "user.email", "machine@example.test"]);
  await execGit(["config", "user.name", "Machine Default"]);
  await execGit(["checkout", "-b", "main"]);
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("commit email derivation", () => {
  test("prefers the account's public address", () => {
    expect(commitEmail("dev@example.com", 42, "octocat")).toBe("dev@example.com");
  });

  test("falls back to the id-qualified noreply address when email is private", () => {
    expect(commitEmail(null, 42, "octocat")).toBe("42+octocat@users.noreply.github.com");
  });

  test("uses the legacy noreply form when no id is available", () => {
    expect(commitEmail(undefined, undefined, "octocat")).toBe(
      "octocat@users.noreply.github.com",
    );
  });
});

describe("identityEnv", () => {
  test("pins both author and committer so the commit is fully attributed", () => {
    expect(
      identityEnv({
        host: "github.com",
        login: "octocat",
        name: "Octo Cat",
        email: "octo@example.com",
      }),
    ).toEqual({
      GIT_AUTHOR_NAME: "Octo Cat",
      GIT_AUTHOR_EMAIL: "octo@example.com",
      GIT_COMMITTER_NAME: "Octo Cat",
      GIT_COMMITTER_EMAIL: "octo@example.com",
    });
  });
});

describe("GitManager.commit with an identity", () => {
  test("stamps the selected account instead of the machine's git config", async () => {
    await writeFile(join(repoDir, "file.txt"), "hello\n");
    await execGit(["add", "file.txt"]);

    await new GitManager(repoDir).commit("add file", {
      identity: {
        host: "github.com",
        login: "octocat",
        name: "Octo Cat",
        email: "42+octocat@users.noreply.github.com",
      },
    });

    expect(await show("%an <%ae>")).toBe("Octo Cat <42+octocat@users.noreply.github.com>");
    expect(await show("%cn <%ce>")).toBe("Octo Cat <42+octocat@users.noreply.github.com>");
  });

  test("leaves the machine identity in place when none is passed", async () => {
    await writeFile(join(repoDir, "file.txt"), "hello\n");
    await execGit(["add", "file.txt"]);

    await new GitManager(repoDir).commit("add file");

    expect(await show("%an <%ae>")).toBe("Machine Default <machine@example.test>");
  });
});

describe("resolveGitIdentityState", () => {
  test("defers to the machine when no account is selected", async () => {
    const state = await resolveGitIdentityState(store, undefined, repoDir);

    expect(state.selected).toBeNull();
    expect(state.diverged).toBe(false);
    expect(state.machine.email).toBe("machine@example.test");
    expect(state.reason).toMatch(/No GitHub account is selected/);
  });

  test("reports divergence when the cached account differs from the machine", async () => {
    await store.setGithubIdentity({
      host: "github.com",
      login: "work",
      name: "Work Account",
      email: "work@example.test",
    });

    const state = await resolveGitIdentityState(store, repository("work"), repoDir);

    expect(state.selected?.email).toBe("work@example.test");
    expect(state.machine.email).toBe("machine@example.test");
    expect(state.diverged).toBe(true);
  });

  test("does not flag divergence when the two identities agree", async () => {
    await store.setGithubIdentity({
      host: "github.com",
      login: "work",
      name: "Machine Default",
      email: "MACHINE@example.test",
    });

    const state = await resolveGitIdentityState(store, repository("work"), repoDir);

    expect(state.diverged).toBe(false);
  });

  test("surfaces the failure as a reason rather than throwing at the commit site", async () => {
    // A stored credential with no token behind it fails resolution. The commit
    // must still be possible — it just falls back to the machine identity.
    const state = await resolveGitIdentityState(
      store,
      { name: "app", path: repoDir, githubCredential: { source: "stored", host: "github.com" } },
      repoDir,
    );

    expect(state.selected).toBeNull();
    expect(state.diverged).toBe(false);
    expect(state.reason).toMatch(/No stored GitHub token/);
  });
});

describe("resolvePushCredential", () => {
  test("declines SSH remotes, where a token cannot change the identity", async () => {
    await expect(
      resolvePushCredential(store, repository("work"), "git@github.com:acme/app.git"),
    ).resolves.toBeNull();
  });

  test("declines when the remote host is not the selected account's host", async () => {
    await expect(
      resolvePushCredential(store, repository("work"), "https://gitlab.com/acme/app.git"),
    ).resolves.toBeNull();
  });

  test("declines when the repository has no account selected", async () => {
    await expect(
      resolvePushCredential(store, { name: "app", path: repoDir }, "https://github.com/a/b.git"),
    ).resolves.toBeNull();
  });
});

describe("httpsRemoteHost", () => {
  test.each([
    ["https://github.com/acme/app.git", "github.com"],
    ["git@github.com:acme/app.git", null],
    ["ssh://git@github.com/acme/app.git", null],
    ["/local/path/repo.git", null],
    [null, null],
  ])("%s → %s", (input, expected) => {
    expect(httpsRemoteHost(input)).toBe(expected);
  });
});

function repository(login: string): GitRepositoryDefinition {
  return {
    name: "app",
    path: repoDir,
    githubCredential: { source: "gh", host: "github.com", login },
  };
}

async function show(format: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["show", "-s", `--format=${format}`], {
    cwd: repoDir,
  });
  return stdout.trim();
}

async function execGit(args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repoDir });
}
