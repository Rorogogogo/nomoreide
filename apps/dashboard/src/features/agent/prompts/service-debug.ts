/**
 * Wraps a service's pre-built agent debug context (health, ports, recent logs,
 * etc.) into a prompt for the dock, so "Debug with AI" hands the agent the full
 * picture and asks it to investigate — the AI-native version of copying the
 * context out by hand.
 */
export function buildServiceDebugPrompt({
  service,
  context,
}: {
  service: string;
  context: string;
}): string {
  return [
    `Here's the current debug context for my \`${service}\` service. Take a look at its`,
    "state and recent logs, tell me what stands out, and help me fix anything that's wrong.",
    "",
    context,
  ].join("\n");
}
