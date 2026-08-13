/**
 * Agent Profiles (ROR-62) — named bundles of MCP servers + skills that can be
 * saved, applied to agents, and shared as portable `.tar.gz` archives.
 *
 * Profiles use nomoreide's own vocabulary (the same local/remote MCP shapes
 * the agent-env readers emit) and are stored as Zod-validated JSON under
 * `~/.config/nomoreide/agent-profiles/<name>/`. This deliberately does NOT
 * read brainctl's YAML profiles — brainctl users migrate by re-snapshotting
 * their live agent configs (one call), which recreates the profile here.
 */
import { z } from "zod";

const stringMapSchema = z.record(z.string());

export const profileLocalMcpSchema = z.object({
  kind: z.literal("local"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: stringMapSchema.optional(),
});

export const profileRemoteMcpSchema = z.object({
  kind: z.literal("remote"),
  transport: z.enum(["http", "sse"]),
  url: z.string().min(1),
  headers: stringMapSchema.optional(),
  env: stringMapSchema.optional(),
});

export const profileMcpSchema = z.discriminatedUnion("kind", [
  profileLocalMcpSchema,
  profileRemoteMcpSchema,
]);

export type ProfileLocalMcp = z.infer<typeof profileLocalMcpSchema>;
export type ProfileRemoteMcp = z.infer<typeof profileRemoteMcpSchema>;
export type ProfileMcp = z.infer<typeof profileMcpSchema>;

/** A skill bundled with the profile; its files live at `<profile>/skills/<name>/`. */
export const profileSkillSchema = z.object({
  name: z.string().min(1),
});

export const profilePluginSchema = z.object({
  name: z.string().min(1),
  sourceAgent: z.enum(["claude", "codex", "antigravity"]),
  source: z.string().optional(),
  version: z.string().optional(),
  managed: z.boolean().optional(),
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  bundleKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  pluginSkills: z.array(z.string()).optional(),
  pluginMcps: z.array(z.string()).optional(),
  pluginAgents: z.array(z.string()).optional(),
  pluginCommands: z.array(z.string()).optional(),
});

export type ProfilePlugin = z.infer<typeof profilePluginSchema>;

export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const profileSchema = z.object({
  name: z.string().regex(PROFILE_NAME_PATTERN),
  description: z.string().optional(),
  /** Agent this profile was snapshotted from. Absent on older/imported profiles. */
  sourceAgent: z.enum(["claude", "codex", "antigravity"]).optional(),
  mcps: z.record(profileMcpSchema).default({}),
  skills: z.array(profileSkillSchema).default([]),
  plugins: z.array(profilePluginSchema).default([]),
});

export type Profile = z.infer<typeof profileSchema>;

/** Credential a portable archive needs filled in at import time. */
export const credentialSpecSchema = z.object({
  key: z.string().min(1),
  required: z.boolean().default(true),
  description: z.string().optional(),
});

export type CredentialSpec = z.infer<typeof credentialSpecSchema>;

/** `manifest.json` inside a portable archive. */
export const profileManifestSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  profileName: z.string().min(1),
  createdBy: z.object({ tool: z.string(), version: z.string() }).optional(),
  credentials: z.array(credentialSpecSchema).optional(),
});

export type ProfileManifest = z.infer<typeof profileManifestSchema>;

export interface ProfileSummary {
  name: string;
  description?: string;
  sourceAgent?: Profile["sourceAgent"];
  mcpCount: number;
  skillCount: number;
  pluginCount: number;
  updatedAt: string;
  registry?: {
    origin: "published" | "installed";
    slug: string;
    version: string;
    linkedAt: string;
    hasLocalChanges: boolean;
  };
}

export function slugifyProfileName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}
