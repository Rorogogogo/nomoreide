import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { profileSchema, type Profile } from "./types.js";

export const NOMOREIDE_DEBUG_PROFILE_NAME = "nomoreide-debug";

export interface BundledAgentProfile {
  profile: Profile;
  skillsDir: string;
}

/** Load the read-only MCP + skill profile shipped with the npm package. */
export async function loadBundledDebugProfile(): Promise<BundledAgentProfile> {
  const root = fileURLToPath(
    new URL(`../../../profiles/${NOMOREIDE_DEBUG_PROFILE_NAME}/`, import.meta.url),
  );
  const profilePath = path.join(root, "profile.json");
  let source: string;
  try {
    source = await readFile(profilePath, "utf8");
  } catch {
    throw new Error(
      `Bundled profile "${NOMOREIDE_DEBUG_PROFILE_NAME}" is missing. Reinstall NoMoreIDE and try again.`,
    );
  }

  let parsedSource: unknown;
  try {
    parsedSource = JSON.parse(source);
  } catch {
    throw new Error(`Bundled profile "${NOMOREIDE_DEBUG_PROFILE_NAME}" contains invalid JSON.`);
  }
  const parsed = profileSchema.safeParse(parsedSource);
  if (!parsed.success) {
    throw new Error(`Bundled profile "${NOMOREIDE_DEBUG_PROFILE_NAME}" is invalid.`);
  }

  return {
    profile: parsed.data,
    skillsDir: path.join(root, "skills"),
  };
}
