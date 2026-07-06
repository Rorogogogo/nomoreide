import type { FastMCP } from "fastmcp";
import { z } from "zod";
import {
  applyProfile,
  copySkillBetweenProfiles,
  createProfile,
  deleteProfile,
  exportProfile,
  getProfile,
  importProfile,
  listProfiles,
  previewProfileApply,
  profileMcpSchema,
  snapshotProfileFromAgent,
  updateProfile,
} from "../../core/agent-profiles/index.js";
import { stringify, type ToolContext } from "./context.js";

export const AGENT_PROFILE_TOOL_NAMES = [
  "nomoreide_profiles_list",
  "nomoreide_profiles_get",
  "nomoreide_profiles_create",
  "nomoreide_profiles_update",
  "nomoreide_profiles_delete",
  "nomoreide_profiles_snapshot",
  "nomoreide_profiles_apply",
  "nomoreide_profiles_export",
  "nomoreide_profiles_import",
  "nomoreide_profiles_copy_items",
] as const;

const agentSchema = z.enum(["claude", "codex", "antigravity"]);
const nameField = z.string().min(1).describe("Profile name.");
const cwdField = z
  .string()
  .min(1)
  .optional()
  .describe("Project directory (defaults to the server's cwd).");

/**
 * Agent Profiles (ROR-62): named MCP+skill bundles. Mutations of agent
 * configs (apply) flow through the write-guarded agent-env layer and echo
 * backup paths; profile CRUD only touches `~/.config/nomoreide/agent-profiles/`.
 */
export function registerAgentProfileTools(server: FastMCP, _ctx: ToolContext): void {
  server.addTool({
    name: "nomoreide_profiles_list",
    description: "List saved agent profiles (named bundles of MCP servers + skills).",
    parameters: z.object({}),
    execute: async () => stringify(await listProfiles()),
  });

  server.addTool({
    name: "nomoreide_profiles_get",
    description: "Get a profile's full config: MCP servers and bundled skills.",
    parameters: z.object({ name: nameField }),
    execute: async ({ name }) => stringify(await getProfile(name)),
  });

  server.addTool({
    name: "nomoreide_profiles_create",
    description:
      'Create an empty profile. Name must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/.',
    parameters: z.object({ name: nameField, description: z.string().optional() }),
    execute: async (input) => stringify(await createProfile(input)),
  });

  server.addTool({
    name: "nomoreide_profiles_update",
    description:
      "Update a profile's description, MCP map, or skill list (name is immutable).",
    parameters: z.object({
      name: nameField,
      description: z.string().optional(),
      mcps: z.record(profileMcpSchema).optional(),
      skills: z.array(z.object({ name: z.string().min(1) })).optional(),
    }),
    execute: async ({ name, ...patch }) => stringify(await updateProfile(name, patch)),
  });

  server.addTool({
    name: "nomoreide_profiles_delete",
    description: "Delete a saved profile (does not touch any agent's live config).",
    parameters: z.object({ name: nameField }),
    execute: async ({ name }) => {
      await deleteProfile(name);
      return stringify({ ok: true, deleted: name });
    },
  });

  server.addTool({
    name: "nomoreide_profiles_snapshot",
    description:
      "Snapshot an agent's live MCPs and user skills into a new profile — useful as a backup before bulk changes or to capture a setup for sharing.",
    parameters: z.object({
      agent: agentSchema,
      name: nameField,
      description: z.string().optional(),
      cwd: cwdField,
    }),
    execute: async (input) =>
      stringify(
        await snapshotProfileFromAgent({ ...input, cwd: input.cwd ?? process.cwd() }),
      ),
  });

  server.addTool({
    name: "nomoreide_profiles_apply",
    description:
      "Apply a profile's MCPs and skills to an agent. Set dryRun=true for a conflict preview (add/identical/conflict per item). A real apply snapshots the agent config first and returns every backup path.",
    parameters: z.object({
      name: nameField,
      agent: agentSchema,
      dryRun: z.boolean().default(false),
      skipMcps: z.array(z.string()).optional().describe("MCP keys to leave untouched."),
      skipSkills: z.array(z.string()).optional().describe("Skill names to leave untouched."),
      cwd: cwdField,
    }),
    execute: async (input) => {
      const cwd = input.cwd ?? process.cwd();
      if (input.dryRun) {
        return stringify(await previewProfileApply({ cwd, name: input.name, agent: input.agent }));
      }
      return stringify(
        await applyProfile({
          cwd,
          name: input.name,
          agent: input.agent,
          skip: { mcps: input.skipMcps, skills: input.skipSkills },
        }),
      );
    },
  });

  server.addTool({
    name: "nomoreide_profiles_export",
    description:
      "Export a profile as a portable .tar.gz. Secret-looking env/header values are redacted to ${credentials.*} placeholders — the archive never contains raw secrets.",
    parameters: z.object({
      name: nameField,
      outputPath: z.string().optional().describe("Defaults to <cwd>/<name>.tar.gz."),
      cwd: cwdField,
    }),
    execute: async (input) =>
      stringify(
        await exportProfile({
          name: input.name,
          outputPath: input.outputPath,
          cwd: input.cwd ?? process.cwd(),
        }),
      ),
  });

  server.addTool({
    name: "nomoreide_profiles_import",
    description:
      "Import a portable profile .tar.gz. Supplied credentials (or matching environment variables) fill ${credentials.*} placeholders; unresolved keys are reported.",
    parameters: z.object({
      archivePath: z.string().min(1),
      force: z.boolean().default(false).describe("Overwrite an existing profile of the same name."),
      as: z.string().optional().describe("Import under a different profile name."),
      credentials: z.record(z.string()).optional(),
    }),
    execute: async (input) => stringify(await importProfile(input)),
  });

  server.addTool({
    name: "nomoreide_profiles_copy_items",
    description:
      "Copy selected MCPs and/or skills from one profile into another (overwrites same-named items in the target).",
    parameters: z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      mcps: z.array(z.string()).optional().describe("MCP keys to copy."),
      skills: z.array(z.string()).optional().describe("Skill names to copy."),
    }),
    execute: async (input) => {
      const source = await getProfile(input.from);
      const target = await getProfile(input.to);

      const mcps = { ...target.mcps };
      const copiedMcps: string[] = [];
      for (const key of input.mcps ?? []) {
        const entry = source.mcps[key];
        if (!entry) throw new Error(`MCP "${key}" not found in profile "${input.from}".`);
        mcps[key] = entry;
        copiedMcps.push(key);
      }

      const skills = [...target.skills];
      const copiedSkills: string[] = [];
      for (const skillName of input.skills ?? []) {
        if (!source.skills.some((skill) => skill.name === skillName)) {
          throw new Error(`Skill "${skillName}" not found in profile "${input.from}".`);
        }
        await copySkillBetweenProfiles(input.from, input.to, skillName);
        if (!skills.some((skill) => skill.name === skillName)) {
          skills.push({ name: skillName });
        }
        copiedSkills.push(skillName);
      }

      await updateProfile(input.to, { mcps, skills });
      return stringify({ ok: true, copiedMcps, copiedSkills });
    },
  });
}
