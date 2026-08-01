/**
 * Agent Profiles (ROR-62): named MCP+skill bundles stored under
 * `~/.config/nomoreide/agent-profiles/`, applied to agents through the
 * write-guarded agent-env layer, shared as credential-redacted tarballs.
 */
export {
  applyProfile,
  applyProfileContents,
  previewProfileApply,
  type ProfileContentsApplyOptions,
  type ProfileApplyItem,
  type ProfileApplyPreview,
  type ProfileApplyResult,
  type ProfileItemStatus,
} from "./apply.js";
export {
  loadBundledDebugProfile,
  NOMOREIDE_DEBUG_PROFILE_NAME,
  type BundledAgentProfile,
} from "./builtin.js";
export {
  DebugSetupConflictError,
  installBundledDebugSetup,
  type DebugSetupAgent,
  type DebugSetupResult,
  type DebugSetupStatus,
} from "./debug-setup.js";
export {
  findUnresolvedCredentialKeys,
  redactMcpCredentials,
  resolveMcpCredentials,
} from "./credentials.js";
export {
  assertValidProfileName,
  copySkillBetweenProfiles,
  copyPluginBetweenProfiles,
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  profileDir,
  profilePluginsDir,
  profilesRoot,
  profileSkillsDir,
  snapshotProfileFromAgent,
  updateProfile,
  writeProfile,
  type ProfileStoreOptions,
} from "./store.js";
export { exportProfile, importProfile, type ExportResult, type ImportResult } from "./transfer.js";
export {
  createRegistryConfigService,
  DEFAULT_REGISTRY_API_BASE_URL,
  DEFAULT_REGISTRY_FRONTEND_URL,
  registryConfigPath,
  resolveRegistryApiBaseUrl,
  resolveRegistryApiTarget,
  resolveRegistryApiToken,
  resolveRegistryFrontendUrl,
  type RegistryApiTarget,
  type RegistryConfigOptions,
  type RegistryConfigService,
} from "./registry-config.js";
export {
  createRegistryTokenManager,
  type RegistryTokenManager,
  type RegistryTokenManagerOptions,
} from "./registry-auth.js";
export {
  createRegistryClient,
  type RegisterGithubProfileInput,
  type RegistryClient,
  type RegistryInstallDescriptor,
  type RegistryProfile,
} from "./registry-client.js";
export {
  installProfileFromRegistry,
  publishProfileToRegistry,
  type InstallFromRegistryInput,
  type InstallFromRegistryResult,
  type PublishProfileInput,
  type PublishProfileResult,
} from "./registry-transfer.js";
export {
  PROFILE_NAME_PATTERN,
  profileManifestSchema,
  profileMcpSchema,
  profilePluginSchema,
  profileSchema,
  slugifyProfileName,
  type CredentialSpec,
  type Profile,
  type ProfileManifest,
  type ProfileMcp,
  type ProfilePlugin,
  type ProfileSummary,
} from "./types.js";
export { pluginIdentity } from "./plugin-bundle.js";
