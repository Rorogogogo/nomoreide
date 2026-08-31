export function buildLargeFileSplitPrompt({
  absolutePath,
  lines,
  relativePath,
}: {
  absolutePath: string;
  lines: number;
  relativePath: string;
}): string {
  return [
    `Please structurally split this large file and preserve behavior: ${relativePath}`,
    "",
    `Absolute path: ${absolutePath}`,
    `Current size: ${lines.toLocaleString()} lines`,
    "",
    "First read the file and nearby imports/tests, then propose the smallest safe decomposition.",
    "Prefer extracting cohesive responsibilities into focused modules over mechanical slicing.",
    "Keep public APIs stable where possible, update imports, and run the relevant tests after editing.",
  ].join("\n");
}
