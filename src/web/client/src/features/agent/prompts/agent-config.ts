import type { AgentHook, AgentMcpServer, AgentPlugin, AgentSkill } from "@/lib/api";
import type { AgentId } from "../agent-types";

/**
 * Prompt builders for the agent Tools tab. Everything here is AI-native: the
 * buttons don't mutate config directly — they hand the active agent a prompt and
 * let it run the real commands (`claude mcp add`, plugin install, file writes).
 * "Add"/"ask" prompts are drafted (the user finishes them); "remove" prompts are
 * pre-written but still drafted so the user reviews before sending.
 */

function agentLabel(agentId: AgentId): string {
  return agentId === "codex" ? "Codex" : "Claude Code";
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export function buildAddSkillPrompt(agentId: AgentId, input: string): string {
  const location =
    agentId === "codex"
      ? "`~/.agents/skills/<name>/SKILL.md` (user) or `.agents/skills/<name>/SKILL.md` (project)"
      : "`~/.claude/skills/<name>/SKILL.md` (user) or `.claude/skills/<name>/SKILL.md` (project)";
  return [
    `Add a new skill for ${agentLabel(agentId)} from this:`,
    "",
    input,
    "",
    `Scaffold it at ${location} with valid frontmatter (\`name\`, \`description\`) and a short body, then confirm it's discovered. If the input is a URL or repo, fetch and adapt it.`,
  ].join("\n");
}

export function buildRemoveSkillPrompt(skill: AgentSkill): string {
  return [
    `Remove the ${skill.scope} skill \`${skill.name}\`${skill.path ? ` (at \`${skill.path}\`)` : ""}.`,
    "",
    "Delete its directory and confirm it's no longer registered. Check nothing else references it first.",
  ].join("\n");
}

export function buildAskSkillPrompt(skill: AgentSkill): string {
  const lines = [
    `I'm looking at the ${skill.scope} skill \`${skill.name}\`${skill.path ? ` (at \`${skill.path}\`)` : ""}.`,
  ];
  if (skill.description) lines.push("", `Its description: ${skill.description}`);
  lines.push("", "My question: ");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export function buildAddMcpPrompt(agentId: AgentId, input: string): string {
  const how =
    agentId === "codex"
      ? "by adding an `[mcp_servers.<name>]` section to `~/.codex/config.toml`"
      : "with `claude mcp add` (or by editing `~/.claude.json`)";
  return [
    `Register a new MCP server for ${agentLabel(agentId)} from this:`,
    "",
    input,
    "",
    `Set it up ${how}, then verify it connects. Parse the name, command/URL, and any env/args from the input above.`,
  ].join("\n");
}

export function buildRemoveMcpPrompt(server: AgentMcpServer, agentId: AgentId): string {
  const how =
    agentId === "codex"
      ? `Remove the \`[mcp_servers.${server.name}]\` section from \`~/.codex/config.toml\`.`
      : `Run \`claude mcp remove ${server.name}\` (scope: ${server.scope}).`;
  return [
    `Remove the ${server.scope} MCP server \`${server.name}\`.`,
    "",
    `${how} Then confirm it no longer appears in the server list.`,
  ].join("\n");
}

export function buildAskMcpPrompt(server: AgentMcpServer): string {
  const lines = [`I'm looking at the ${server.scope} MCP server \`${server.name}\`.`];
  const target = server.command
    ? [server.command, ...(server.args ?? [])].join(" ")
    : server.url ?? server.type;
  if (target) lines.push("", `It points at: \`${target}\``);
  lines.push("", "My question: ");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export function buildAddPluginPrompt(agentId: AgentId, input: string): string {
  return [
    `Install a plugin for ${agentLabel(agentId)} from this:`,
    "",
    input,
    "",
    "Use the `/plugin` command or `claude plugin install <name>@<marketplace>` (add the marketplace first if needed), then confirm its skills, commands, and MCP servers are available.",
  ].join("\n");
}

export function buildRemovePluginPrompt(plugin: AgentPlugin): string {
  const from = plugin.marketplace ? ` (from \`${plugin.marketplace}\`)` : "";
  return [
    `Uninstall the plugin \`${plugin.name}\`${from}.`,
    "",
    "Use `claude plugin uninstall` or the `/plugin` command, then confirm its skills, commands, and MCP servers are gone.",
  ].join("\n");
}

export function buildAskPluginPrompt(plugin: AgentPlugin): string {
  const lines = [
    `I'm looking at the plugin \`${plugin.name}\`${
      plugin.marketplace ? ` from \`${plugin.marketplace}\`` : ""
    }${plugin.version ? ` (v${plugin.version})` : ""}.`,
  ];
  if (plugin.description) lines.push("", plugin.description);
  const contributes: string[] = [];
  if (plugin.skills.length) contributes.push(`skills: ${plugin.skills.join(", ")}`);
  if (plugin.commands.length) contributes.push(`commands: ${plugin.commands.join(", ")}`);
  if (plugin.agents.length) contributes.push(`agents: ${plugin.agents.join(", ")}`);
  if (plugin.mcpServers.length) contributes.push(`MCP servers: ${plugin.mcpServers.join(", ")}`);
  if (contributes.length) {
    lines.push("", "It contributes —");
    lines.push(...contributes.map((line) => `- ${line}`));
  }
  lines.push("", "My question: ");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function buildAddHookPrompt(agentId: AgentId, input: string): string {
  const location =
    agentId === "codex"
      ? "`~/.codex/config.toml` if this Codex version supports hooks"
      : "`~/.claude/settings.json` (user) or `.claude/settings.json` (project)";
  return [
    `Add a hook for ${agentLabel(agentId)} from this:`,
    "",
    input,
    "",
    `Configure it in ${location}. Pick the correct hook event, matcher, command, and scope from the request, then confirm it appears in the agent tools view.`,
  ].join("\n");
}

export function buildRemoveHookPrompt(hook: AgentHook): string {
  const matcher = hook.matcher ? ` with matcher \`${hook.matcher}\`` : "";
  const command = hook.command ? ` running \`${hook.command}\`` : "";
  return [
    `Remove the ${hook.scope} \`${hook.event}\` hook${matcher}${command}.`,
    "",
    `Edit \`${hook.settingsPath}\`, remove only that hook entry, and confirm it no longer appears in the hooks list.`,
  ].join("\n");
}

export function buildAskHookPrompt(hook: AgentHook): string {
  const lines = [
    `I'm looking at the ${hook.scope} \`${hook.event}\` hook in \`${hook.settingsPath}\`.`,
  ];
  if (hook.matcher) lines.push("", `Matcher: \`${hook.matcher}\``);
  if (hook.type) lines.push(`Type: \`${hook.type}\``);
  if (hook.command) lines.push(`Command: \`${hook.command}\``);
  lines.push("", "My question: ");
  return lines.join("\n");
}
