/**
 * Handed to the dock agent when the user clicks the "AI" cut on "Create Group".
 * The agent looks at the currently ungrouped services, proposes one or more
 * logical groupings, confirms with the user, and only then registers them via
 * the nomoreide CLI — so nothing is grouped without an explicit yes.
 */
export interface GroupableService {
  name: string;
  command?: string;
  cwd?: string;
  port?: number;
  description?: string;
}

export function buildGroupServicesPrompt(services: GroupableService[]): string {
  const roster = services.length
    ? services
        .map((service) => {
          const parts = [`- ${service.name}`];
          if (service.command) parts.push(`command: \`${service.command}\``);
          if (service.cwd) parts.push(`cwd: \`${service.cwd}\``);
          if (typeof service.port === "number") parts.push(`port: ${service.port}`);
          if (service.description) parts.push(service.description);
          return parts.join(" — ");
        })
        .join("\n")
    : "- (none — all services are already grouped)";

  return [
    "I have these ungrouped services in NoMoreIDE and I'd like to organise them into groups",
    "(groups let me start/stop related services together):",
    "",
    roster,
    "",
    "Look at their names, commands, directories and ports and propose how to group them —",
    "for example a frontend + backend that share a repo, or services that boot together.",
    "Group only the ones that genuinely belong together; it's fine to leave some ungrouped.",
    "",
    "Present your proposal as a short list of `group name → services` and end that message",
    "with a fenced `options` block so I can confirm, e.g.:",
    "```options",
    "Yes, create these groups",
    "Let me adjust them first",
    "```",
    "",
    "Do NOT create anything until I confirm. Once I say yes, register each group by running:",
    "  nomoreide add bundle <group-name> <service> <service> ...",
    "Then tell me which groups you created.",
  ].join("\n");
}
