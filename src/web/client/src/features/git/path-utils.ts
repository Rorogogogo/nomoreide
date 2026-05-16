export function pathName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "project";
}
