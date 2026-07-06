import {
  applyProfile,
  createRegistryTokenManager,
  deleteProfile,
  exportProfile,
  getProfile,
  importProfile,
  installProfileFromRegistry,
  listProfiles,
  previewProfileApply,
  publishProfileToRegistry,
  resolveRegistryApiBaseUrl,
  resolveRegistryApiToken,
  snapshotProfileFromAgent,
} from "../core/agent-profiles/index.js";
import { AGENT_NAMES, type AgentName } from "../core/agent-env/index.js";
import { UsageError } from "./errors.js";
import { parseFlags } from "./flags.js";

const USAGE = [
  "Usage: nomoreide profile <subcommand>",
  "  list                                  saved profiles",
  "  show <name>                           full profile JSON",
  "  snapshot <agent> <name> [--description <text>]",
  "  apply <name> <agent> [--dry-run] [--skip-mcps a,b] [--skip-skills x,y]",
  "  export <name> [--output <path>]      credential-redacted .tar.gz",
  "  import <archive> [--force] [--as <name>]",
  "  delete <name>",
  "  publish <name> --slug <slug> --title <title> [--version <v>] [--summary <text>]",
  "  install <slug> [--force] [--as <name>]   install from the hosted registry",
].join("\n");

/** Agent profiles on the CLI (ROR-64) — same core as the UI and MCP tools. */
export async function runProfileCli(
  subcommand: string | undefined,
  args: string[],
  stdout: (line: string) => void,
): Promise<number> {
  const cwd = process.cwd();
  const flags = parseFlags(args);
  const positional = args.filter((arg, index) => {
    if (arg.startsWith("--")) return false;
    const previous = args[index - 1];
    return !(previous?.startsWith("--") && !previous.includes("="));
  });
  const has = (flag: string) => args.includes(flag);

  if (subcommand === undefined || subcommand === "list") {
    const profiles = await listProfiles();
    if (profiles.length === 0) {
      stdout("No profiles yet. Create one with: nomoreide profile snapshot <agent> <name>");
      return 0;
    }
    stdout("Name\tMCPs\tSkills\tUpdated\tDescription");
    for (const profile of profiles) {
      stdout(
        `${profile.name}\t${profile.mcpCount}\t${profile.skillCount}\t${profile.updatedAt}\t${profile.description ?? ""}`,
      );
    }
    return 0;
  }

  if (subcommand === "show") {
    const name = requirePositional(positional[0], "profile name");
    stdout(JSON.stringify(await getProfile(name), null, 2));
    return 0;
  }

  if (subcommand === "snapshot") {
    const agent = requireAgent(positional[0]);
    const name = requirePositional(positional[1], "profile name");
    const profile = await snapshotProfileFromAgent({
      agent,
      name,
      description: flags.description,
      cwd,
    });
    stdout(
      `Snapshotted ${agent} into "${profile.name}" (${Object.keys(profile.mcps).length} MCPs, ${profile.skills.length} skills)`,
    );
    return 0;
  }

  if (subcommand === "apply") {
    const name = requirePositional(positional[0], "profile name");
    const agent = requireAgent(positional[1]);
    if (has("--dry-run")) {
      const preview = await previewProfileApply({ cwd, name, agent });
      stdout("Item\tStatus");
      for (const item of preview.items) {
        const warnings = item.warnings.length > 0 ? ` (${item.warnings.join("; ")})` : "";
        stdout(`${item.category} ${item.name}\t${item.status}${warnings}`);
      }
      if (preview.unresolvedCredentials.length > 0) {
        stdout(`Unresolved credentials: ${preview.unresolvedCredentials.join(", ")}`);
      }
      return 0;
    }
    const result = await applyProfile({
      cwd,
      name,
      agent,
      skip: { mcps: splitList(flags.skipMcps), skills: splitList(flags.skipSkills) },
    });
    stdout(
      `Applied "${result.profile}" to ${result.agent}: ${result.mcpsApplied.length} MCPs, ${result.skillsApplied.length} skills` +
        (result.skipped.length > 0 ? `, skipped ${result.skipped.join(", ")}` : ""),
    );
    for (const backup of result.backups) stdout(`Backup: ${backup}`);
    return 0;
  }

  if (subcommand === "export") {
    const name = requirePositional(positional[0], "profile name");
    const result = await exportProfile({ name, outputPath: flags.output, cwd });
    stdout(`Exported to ${result.archivePath} (credentials redacted)`);
    if (result.credentials.length > 0) {
      stdout(`Importers must supply: ${result.credentials.map((spec) => spec.key).join(", ")}`);
    }
    return 0;
  }

  if (subcommand === "import") {
    const archivePath = requirePositional(positional[0], "archive path");
    const result = await importProfile({ archivePath, force: has("--force"), as: flags.as });
    stdout(`Imported "${result.name}" (${result.mcpCount} MCPs, ${result.skillCount} skills)`);
    reportMissingCredentials(result.missingCredentials, stdout);
    return 0;
  }

  if (subcommand === "delete") {
    const name = requirePositional(positional[0], "profile name");
    await deleteProfile(name);
    stdout(`Deleted profile "${name}"`);
    return 0;
  }

  if (subcommand === "publish") {
    const name = requirePositional(positional[0], "profile name");
    if (!flags.slug || !flags.title) throw new UsageError("--slug and --title are required");
    const tokenManager = createRegistryTokenManager();
    if ((await tokenManager.getAccessToken()) === null) {
      throw new UsageError(
        "Not signed in to the registry. Sign in from the web UI (Agent Environments) or set BRAINCTL_API_TOKEN.",
      );
    }
    const result = await publishProfileToRegistry({
      name,
      slug: flags.slug,
      title: flags.title,
      summary: flags.summary,
      version: flags.version,
      cwd,
      apiBaseUrl: await resolveRegistryApiBaseUrl(),
      fetch: (input, init) =>
        tokenManager.authenticatedFetch(
          typeof input === "string" ? input : input.toString(),
          init,
        ),
    });
    stdout(`Published "${result.slug}" v${result.version} to the registry (credentials redacted)`);
    return 0;
  }

  if (subcommand === "install") {
    const slug = requirePositional(positional[0], "registry slug");
    const result = await installProfileFromRegistry({
      slug,
      force: has("--force"),
      as: flags.as,
      apiBaseUrl: await resolveRegistryApiBaseUrl(),
      token: (await resolveRegistryApiToken())?.token,
    });
    stdout(
      `Installed "${result.name}" v${result.version} (${result.mcpCount} MCPs, ${result.skillCount} skills)`,
    );
    reportMissingCredentials(result.missingCredentials, stdout);
    return 0;
  }

  throw new UsageError(USAGE);
}

function requirePositional(value: string | undefined, label: string): string {
  if (!value) throw new UsageError(`${label} is required`);
  return value;
}

function requireAgent(value: string | undefined): AgentName {
  if (!value || !AGENT_NAMES.includes(value as AgentName)) {
    throw new UsageError(`agent is required (one of: ${AGENT_NAMES.join(", ")})`);
  }
  return value as AgentName;
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function reportMissingCredentials(
  missing: Array<{ key: string }>,
  stdout: (line: string) => void,
): void {
  if (missing.length === 0) return;
  stdout(
    `Credentials still needed (placeholders kept): ${missing.map((spec) => spec.key).join(", ")}`,
  );
}
