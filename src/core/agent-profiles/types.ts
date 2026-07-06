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

export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const profileSchema = z.object({
  name: z.string().regex(PROFILE_NAME_PATTERN),
  description: z.string().optional(),
  mcps: z.record(profileMcpSchema).default({}),
  skills: z.array(profileSkillSchema).default([]),
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
  schemaVersion: z.literal(1),
  profileName: z.string().min(1),
  createdBy: z.object({ tool: z.string(), version: z.string() }).optional(),
  credentials: z.array(credentialSpecSchema).optional(),
});

export type ProfileManifest = z.infer<typeof profileManifestSchema>;

export interface ProfileSummary {
  name: string;
  description?: string;
  mcpCount: number;
  skillCount: number;
  updatedAt: string;
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
