import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { callMcpTool, type McpCommand } from "./support/mcp-contract.js";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function text(response: Awaited<ReturnType<typeof callMcpTool>>): string {
  const content = (response.result as { content?: Array<{ text?: string }> })?.content;
  return content?.[0]?.text ?? "";
}

/**
 * The built `nomoreide`, which this test drives as an MCP server.
 *
 * `NOMOREIDE_TEST_BINARY` first so a release build can be checked the same
 * way; otherwise the debug binary a `cargo build` leaves behind.
 */
function candidateBinary(): string {
  const override = process.env.NOMOREIDE_TEST_BINARY;
  if (override) return override;
  const target = process.env.CARGO_TARGET_DIR ?? join(root, "target");
  return join(target, "debug", "nomoreide");
}

// This drives the real binary, which the Node test matrix does not build —
// it installs Node and runs vitest, nothing more. Rather than let that job
// fail on a missing binary, the test declares what it needs and is skipped
// where that is absent. So that skipping it never means *not running it*,
// `ci.yml`'s `desktop-check` job — which does build the workspace — runs this
// file explicitly after `cargo build`.
const binary = candidateBinary();
const built = existsSync(binary);
const describeIfBuilt = built ? describe : describe.skip;
if (!built) {
  console.warn(
    `Skipping MCP redaction test: no binary at ${binary}. ` +
      "Run `cargo build -p nomoreide` to include it.",
  );
}

describeIfBuilt("git config tools over MCP", () => {
  /**
   * These tools answer with the whole config, which holds every stored GitHub
   * token. The dashboard's own API has always redacted it; the agent surface
   * has to as well, or asking which repository is selected hands an agent the
   * user's personal access tokens.
   */
  test("never answer with a stored GitHub token", async () => {
    const base = await mkdtemp(join(tmpdir(), "nomoreide-git-redaction-"));
    tempDirs.push(base);
    const home = join(base, "home");
    await mkdir(join(home, ".config", "nomoreide"), { recursive: true });
    const repository = join(base, "repo");
    await mkdir(repository, { recursive: true });
    await execFileAsync("git", ["init", "--quiet"], { cwd: repository });

    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    // The native binary, the TypeScript one it used to drive having been
    // deleted with the rest of the port's reference implementation. This is a
    // security assertion — a stored token must never come back out of a git
    // config read — so it is worth keeping pointed at what actually ships.
    const command: McpCommand = {
      command: binary,
      args: ["mcp"],
      cwd: root,
      env: {
        ...env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        NOMOREIDE_AUTO_UI: "0",
      },
    };

    const secret = "ghp_redaction_probe_token";
    await callMcpTool(command, "nomoreide_github_set_token", { token: secret });
    const registered = text(
      await callMcpTool(command, "nomoreide_git_register_repository", {
        name: "demo",
        path: repository,
      }),
    );
    const selected = text(
      await callMcpTool(command, "nomoreide_git_select_repository", { name: "demo" }),
    );

    expect(registered).not.toContain(secret);
    expect(selected).not.toContain(secret);
    // The host is still reported, so an agent can tell an account is connected
    // without being told how to act as it.
    expect(JSON.parse(selected).githubTokens).toEqual([{ host: "github.com" }]);
  }, 60_000);
});
