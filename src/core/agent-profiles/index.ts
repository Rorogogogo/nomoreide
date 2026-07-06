/**
 * Agent Profiles (ROR-62): named MCP+skill bundles stored under
 * `~/.config/nomoreide/agent-profiles/`, applied to agents through the
 * write-guarded agent-env layer, shared as credential-redacted tarballs.
 */
export {
  applyProfile,
  previewProfileApply,
  type ProfileApplyItem,
  type ProfileApplyPreview,
  type ProfileApplyResult,
  type ProfileItemStatus,
} from "./apply.js";
export {
  findUnresolvedCredentialKeys,
  redactMcpCredentials,
  resolveMcpCredentials,
} from "./credentials.js";
export {
  assertValidProfileName,
  copySkillBetweenProfiles,
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  profileDir,
  profilesRoot,
  profileSkillsDir,
  snapshotProfileFromAgent,
  updateProfile,
  writeProfile,
  type ProfileStoreOptions,
} from "./store.js";
export { exportProfile, importProfile, type ExportResult, type ImportResult } from "./transfer.js";
export {
  PROFILE_NAME_PATTERN,
  profileManifestSchema,
  profileMcpSchema,
  profileSchema,
  slugifyProfileName,
  type CredentialSpec,
  type Profile,
  type ProfileManifest,
  type ProfileMcp,
  type ProfileSummary,
} from "./types.js";
