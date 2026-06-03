import type { AgentProfile } from "@/lib/api";
import type { AgentId } from "./agent-types";
import { HooksCard } from "./tools/hooks-card";
import { McpServersCard } from "./tools/mcp-servers-card";
import { PluginsCard } from "./tools/plugins-card";
import { SkillsCard } from "./tools/skills-card";

/**
 * Tools tab: the agent's installed capabilities — skills, MCP servers, plugins,
 * and hooks. Every card is AI-native: add/remove/ask buttons hand a prompt to
 * the dock agent rather than mutating config directly (see prompts/agent-config.ts).
 */
export function ToolsTab({
  agent,
  agentId,
  alternateHooks,
}: {
  agent: AgentProfile;
  agentId: AgentId;
  alternateHooks?: { agentLabel: string; count: number };
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
      <SkillsCard agent={agent} agentId={agentId} />
      <McpServersCard agent={agent} agentId={agentId} />
      <PluginsCard agent={agent} agentId={agentId} />
      <HooksCard agent={agent} agentId={agentId} alternateHooks={alternateHooks} />
    </div>
  );
}
