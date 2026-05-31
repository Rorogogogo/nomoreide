import type { AgentProfile } from "@/lib/api";
import type { AgentId } from "./agent-types";
import { McpServersCard } from "./tools/mcp-servers-card";
import { PluginsCard } from "./tools/plugins-card";
import { SkillsCard } from "./tools/skills-card";

/**
 * Tools tab: the agent's installed capabilities — skills, MCP servers, and
 * plugins. Every card is AI-native: add/remove/ask buttons hand a prompt to the
 * dock agent rather than mutating config directly (see prompts/agent-config.ts).
 */
export function ToolsTab({ agent, agentId }: { agent: AgentProfile; agentId: AgentId }) {
  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-1 divide-y divide-border xl:grid-cols-2 xl:divide-x xl:divide-y-0">
        <SkillsCard agent={agent} agentId={agentId} />
        <McpServersCard agent={agent} agentId={agentId} />
      </div>
      <PluginsCard agent={agent} agentId={agentId} />
    </div>
  );
}
