export type NextChangeDecision =
  | { kind: "confirm-next-file"; filePath: string }
  | { kind: "file"; filePath: string }
  | { kind: "hunk"; activeHunkIndex: number }
  | { kind: "none" };

export function nextChangeDecision({
  activeHunkIndex,
  filePaths,
  hunkCount,
  pendingNextFilePath,
  selectedFile,
}: {
  activeHunkIndex: number;
  filePaths: string[];
  hunkCount: number;
  pendingNextFilePath: string | null;
  selectedFile: string;
}): NextChangeDecision {
  if (hunkCount > 0 && activeHunkIndex < hunkCount - 1) {
    return { kind: "hunk", activeHunkIndex: activeHunkIndex + 1 };
  }

  const currentFileIndex = filePaths.indexOf(selectedFile);
  const nextFilePath = filePaths[currentFileIndex + 1];
  if (!nextFilePath) {
    return { kind: "none" };
  }

  if (pendingNextFilePath === nextFilePath) {
    return { kind: "file", filePath: nextFilePath };
  }

  return { kind: "confirm-next-file", filePath: nextFilePath };
}
