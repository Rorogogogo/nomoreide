export const FILE_PREVIEW_BYTES = 256 * 1024;
export const FILE_READ_TIMEOUT_MS = 10_000;

export type ReadOnlyFileType = "directory" | "file" | "symlink" | "other";

export interface ReadOnlyFileEntry {
  name: string;
  path: string;
  type: ReadOnlyFileType;
  size: number;
  modifiedAt: number | null;
}

export interface ReadOnlyDirectoryListing {
  path: string;
  entries: ReadOnlyFileEntry[];
}

export interface ReadOnlyFileContent {
  path: string;
  content: string;
  size: number;
  binary: boolean;
  truncated: boolean;
}

/** Script shared by SSH and `docker exec`; emits machine-readable NUL fields. */
export const READ_DIRECTORY_SCRIPT = String.raw`target=$1
cd "$target" || exit 1
printf 'NMI_PATH\0%s\0' "$PWD"
find . -mindepth 1 -maxdepth 1 -printf 'NMI_ENTRY\0%f\0%y\0%s\0%T@\0\0'`;

/** Return a bounded preview plus the full byte size in a NUL-delimited header. */
export const READ_FILE_SCRIPT = String.raw`target=$1
test -f "$target" || { printf '%s\n' 'Path is not a regular file.' >&2; exit 1; }
size=$(wc -c < "$target") || exit 1
printf 'NMI_FILE\0%s\0' "$size"
head -c ${FILE_PREVIEW_BYTES + 1} -- "$target"`;

export function assertReadOnlyPath(path: string, requireAbsolute = false): void {
  if (!path || path.includes("\0") || (requireAbsolute && !path.startsWith("/"))) {
    throw new Error(requireAbsolute ? "File path must be absolute." : "File path is invalid.");
  }
  if (path !== "." && !path.startsWith("/")) {
    throw new Error("File path must be absolute.");
  }
}

export function parseReadOnlyDirectory(
  output: Buffer,
  includeHidden = false,
): ReadOnlyDirectoryListing {
  const fields = output.toString("utf8").split("\0");
  if (fields[0] !== "NMI_PATH" || !fields[1]?.startsWith("/")) {
    throw new Error("Directory returned an unexpected response.");
  }
  const path = fields[1];
  const entries: ReadOnlyFileEntry[] = [];
  for (let index = 2; index < fields.length; index += 6) {
    if (!fields[index]) break;
    if (fields[index] !== "NMI_ENTRY") {
      throw new Error("Directory entry is malformed.");
    }
    const name = fields[index + 1] ?? "";
    const rawType = fields[index + 2] ?? "";
    const size = Number(fields[index + 3]);
    const modifiedSeconds = Number(fields[index + 4]);
    if (!name || name.includes("/") || !Number.isFinite(size)) {
      throw new Error("Directory entry is malformed.");
    }
    if (!includeHidden && name.startsWith(".")) continue;
    entries.push({
      name,
      path: path === "/" ? `/${name}` : `${path}/${name}`,
      type: readOnlyFileType(rawType),
      size,
      modifiedAt: Number.isFinite(modifiedSeconds) ? Math.round(modifiedSeconds * 1000) : null,
    });
  }
  entries.sort((left, right) => {
    if (left.type !== right.type) {
      if (left.type === "directory") return -1;
      if (right.type === "directory") return 1;
    }
    return left.name.localeCompare(right.name);
  });
  return { path, entries };
}

export function parseReadOnlyFile(path: string, output: Buffer): ReadOnlyFileContent {
  const firstNull = output.indexOf(0);
  const secondNull = output.indexOf(0, firstNull + 1);
  if (firstNull < 0 || secondNull < 0 || output.subarray(0, firstNull).toString() !== "NMI_FILE") {
    throw new Error("File returned an unexpected response.");
  }
  const size = Number(output.subarray(firstNull + 1, secondNull).toString());
  if (!Number.isFinite(size) || size < 0) {
    throw new Error("File returned an invalid size.");
  }
  const bytes = output.subarray(secondNull + 1);
  const preview = bytes.subarray(0, FILE_PREVIEW_BYTES);
  const binary = preview.subarray(0, 8 * 1024).includes(0);
  return {
    path,
    content: binary ? "" : preview.toString("utf8"),
    size,
    binary,
    truncated: size > preview.length,
  };
}

function readOnlyFileType(value: string): ReadOnlyFileType {
  if (value === "d") return "directory";
  if (value === "f") return "file";
  if (value === "l") return "symlink";
  return "other";
}
