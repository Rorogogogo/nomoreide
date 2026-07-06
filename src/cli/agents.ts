import {
  getAgentAvailability,
  readAllAgentConfigs,
  runAgentDoctor,
  AGENT_NAMES,
  type AgentName,
} from "../core/agent-env/index.js";
import { UsageError } from "./errors.js";

const USAGE = "Usage: nomoreide agents [status|doctor|read [claude|codex|antigravity]]";

/** Agent Environments on the CLI (ROR-64) — read-only, same core as UI/MCP. */
export async function runAgentsCli(
  subcommand: string | undefined,
  args: string[],
  stdout: (line: string) => void,
): Promise<number> {
  const cwd = process.cwd();

  if (subcommand === undefined || subcommand === "status") {
    const [availability, configs] = await Promise.all([
      getAgentAvailability(),
      readAllAgentConfigs({ cwd }),
    ]);
    const byAgent = new Map(availability.map((entry) => [entry.agent, entry]));
    stdout("Agent\tInstalled\tMCPs\tSkills\tConfig");
    for (const config of configs) {
      const installed = byAgent.get(config.agent)?.available ? "yes" : "no";
      const mcpCount =
        Object.keys(config.mcpServers).length +
        Object.keys(config.remoteMcpServers).length +
        Object.keys(config.projectMcpServers).length +
        Object.keys(config.projectRemoteMcpServers).length;
      stdout(
        `${config.agent}\t${installed}\t${mcpCount}\t${config.skills.length}\t${config.exists ? config.configPath : "(none)"}`,
      );
    }
    return 0;
  }

  if (subcommand === "doctor") {
    const result = await runAgentDoctor({ cwd });
    for (const check of result.checks) {
      stdout(`${check.status === "ok" ? "ok" : "warn"}\t${check.label}\t${check.message}`);
    }
    return result.hasIssues ? 1 : 0;
  }

  if (subcommand === "read") {
    const agent = args.find((arg) => !arg.startsWith("--"));
    if (agent && !AGENT_NAMES.includes(agent as AgentName)) {
      throw new UsageError(`Unknown agent "${agent}". Use one of: ${AGENT_NAMES.join(", ")}`);
    }
    const configs = await readAllAgentConfigs({ cwd });
    const selected = agent ? configs.filter((config) => config.agent === agent) : configs;
    stdout(JSON.stringify(agent ? selected[0] : selected, null, 2));
    return 0;
  }

  throw new UsageError(USAGE);
}
