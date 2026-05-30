/**
 * Central home for the agent-facing prompt formats the UI feeds into the dock
 * via {@link useAgentDock}().sendToAgent. Keep prompt copy here (one file per
 * surface) rather than inline in components, so the wording stays consistent and
 * easy to tweak in one place.
 */
export { SETUP_SERVICE_PROMPT } from "./service-setup";
export { buildRowPrompt } from "./database-row";
