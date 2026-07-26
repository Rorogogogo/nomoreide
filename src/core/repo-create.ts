import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { defaultReposDir } from "./repo-onboard.js";

const execFileAsync = promisify(execFile);

/**
 * Create a brand-new Git project from nothing: make the directory, `git init`
 * it, and seed a README so the folder is not empty.
 *
 * Like cloning, this is an additive write that deliberately lives outside the
 * read-safe GitManager. It only ever creates a *new* directory — it refuses to
 * touch one that already has contents — so it can never clobber existing work.
 */

const UNSAFE_NAME = /[^a-zA-Z0-9._-]+/g;

/** Sanitise a user-typed project name into a safe single directory segment. */
export function sanitizeProjectName(raw: string): string {
  const name = raw
    .trim()
    .replace(UNSAFE_NAME, "-")
    .replace(/^[-.]+|-+$/g, "");
  if (!name) throw new Error("Project name is required.");
  return name;
}

export interface CreateRepoResult {
  name: string;
  path: string;
}

async function isNonEmptyDir(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Create `<parentDir>/<name>` as an initialised Git repository. `parentDir`
 * defaults to the managed repos dir, the same place clones land.
 */
export async function createRepository(
  rawName: string,
  parentDir: string = defaultReposDir(),
): Promise<CreateRepoResult> {
  const name = sanitizeProjectName(rawName);
  const parent = resolve(parentDir);
  if (!parent.startsWith("/")) throw new Error("Parent directory must be an absolute path.");
  const path = join(parent, name);
  if (await isNonEmptyDir(path)) {
    throw new Error(`Destination already exists and is not empty: ${path}.`);
  }
  await mkdir(path, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: path });
  await writeFile(join(path, "README.md"), `# ${name}\n`, "utf8");
  return { name, path };
}
