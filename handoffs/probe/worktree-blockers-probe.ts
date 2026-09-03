/**
 * Probe: does starting a service inside a worktree actually reach `running`,
 * and does a terminal opened after selecting that worktree report its cwd?
 * Run against the reference alone — this is about learning the behaviour, not
 * comparing two of them.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { referenceSpec, RuntimeHarness } from "../../test/support/runtime-parity.js";

const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "nmi-wt-probe-"));
const harness = new RuntimeHarness(root);

try {
  const runtime = await harness.provision(
    referenceSpec(),
    (partial) => ({
      version: 1,
      services: [
        {
          name: "sleeper",
          command: "sleep 600",
          cwd: join(partial.home, ".nomoreide", "worktrees", "repo", "wt-two"),
        },
      ],
      bundles: [],
      gitRepositories: [{ name: "repo", path: partial.workspace }],
      selectedGitRepository: "repo",
    }),
    () => [],
  );
  const git = (...args: string[]) => run("git", args, { cwd: runtime.workspace });
  await git("init", "--quiet", "--initial-branch", "master");
  await git("config", "user.email", "p@example.com");
  await git("config", "user.name", "P");
  await writeFile(join(runtime.workspace, "readme.txt"), "seed\n");
  await git("add", "-A");
  await git("commit", "--quiet", "-m", "first");
  await harness.startDaemon(runtime);

  const credential = await readFile(join(runtime.home, ".nomoreide", "daemon.credential"), "utf8")
    .then((v) => v.trim())
    .catch(() => "");
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: text };
    }
  };

  const made = await call("/api/git/worktrees", {
    method: "POST",
    body: JSON.stringify({ branch: "wt-two", createBranch: true }),
  });
  console.log("create:", JSON.stringify(made).slice(0, 220));
  const created = (made.body as { worktree?: { path?: string } })?.worktree?.path;

  console.log("start:", JSON.stringify(await call("/api/services/sleeper/start", { method: "POST" })).slice(0, 400));
  await new Promise((r) => setTimeout(r, 1500));
  const status = await call("/api/services");
  console.log("status:", JSON.stringify(status).slice(0, 500));

  // A terminal follows the *selected* worktree, so select it first.
  console.log("select:", JSON.stringify(await call("/api/git/worktrees/active", {
    method: "PUT",
    body: JSON.stringify({ path: created }),
  })).slice(0, 200));
  const session = await call("/api/terminal/sessions", { method: "POST", body: JSON.stringify({}) });
  console.log("terminal:", JSON.stringify(session).slice(0, 400));

  console.log("remove-while-busy:", JSON.stringify(await call("/api/git/worktrees", {
    method: "DELETE",
    body: JSON.stringify({ path: created }),
  })).slice(0, 300));

  await call("/api/git/worktrees/active", {
    method: "PUT",
    body: JSON.stringify({ path: runtime.workspace }),
  });
  console.log("remove-after-switch:", JSON.stringify(await call("/api/git/worktrees", {
    method: "DELETE",
    body: JSON.stringify({ path: created }),
  })).slice(0, 300));
} finally {
  await harness.shutdown();
  await rm(root, { recursive: true, force: true });
}
