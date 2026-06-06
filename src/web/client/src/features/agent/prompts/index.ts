/**
 * Central home for the agent-facing prompt formats the UI feeds into the dock
 * via {@link useAgentDock}().sendToAgent. Keep prompt copy here (one file per
 * surface) rather than inline in components, so the wording stays consistent and
 * easy to tweak in one place.
 */
export { SETUP_SERVICE_PROMPT } from "./service-setup";
export { DATABASE_SETUP_PROMPT } from "./database-setup";
export { onboardRepoPrompt } from "./repo-onboard";
export { buildRowPrompt } from "./database-row";
export { buildTablePrompt } from "./database-table";
export { buildGenerateSqlPrompt } from "./database-generate-sql";
export { buildDebugSqlPrompt } from "./database-debug-sql";
export { buildLargeFileSplitPrompt } from "./large-file";
export { buildCommitPrompt } from "./git-commit";
export { buildCommitMessagePrompt } from "./git-commit-message";
export {
  buildCommitDirtyPrompt,
  buildPullRebasePrompt,
  buildFixCiPrompt,
} from "./git-situation";
export { buildGroupServicesPrompt, type GroupableService } from "./group-services";
export { buildServiceDebugPrompt } from "./service-debug";
export {
  buildAiContextLabel,
  buildAiContextPrompt,
  emptyAiContextSelection,
  hasAiContextSelection,
  type AiContextSelection,
} from "./ai-context";
export {
  buildAddSkillPrompt,
  buildRemoveSkillPrompt,
  buildAskSkillPrompt,
  buildAddMcpPrompt,
  buildRemoveMcpPrompt,
  buildAskMcpPrompt,
  buildAddPluginPrompt,
  buildRemovePluginPrompt,
  buildAskPluginPrompt,
  buildAddHookPrompt,
  buildRemoveHookPrompt,
  buildAskHookPrompt,
} from "./agent-config";
