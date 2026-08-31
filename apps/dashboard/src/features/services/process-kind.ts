export type ProcessKind =
  | "bun"
  | "cargo"
  | "deno"
  | "dotnet"
  | "docker"
  | "go"
  | "node"
  | "npm"
  | "pnpm"
  | "python"
  | "rust"
  | "vite"
  | "yarn"
  | "generic";

export interface ProcessKindInfo {
  kind: ProcessKind;
  label: string;
}

export function processKindForCommand(command: string): ProcessKindInfo {
  const normalized = command.toLowerCase();

  if (/\bvite\b/.test(normalized)) return processKinds.vite;
  if (/\bcargo\s+/.test(normalized)) return processKinds.cargo;
  if (/\brustc\b/.test(normalized)) return processKinds.rust;
  if (/\bdotnet\b/.test(normalized)) return processKinds.dotnet;
  if (/\bdocker(?:\s+compose|-compose|\s+)/.test(normalized)) return processKinds.docker;
  if (/\bpython3?\b|\buvicorn\b|\bfastapi\b/.test(normalized)) return processKinds.python;
  if (/\bgo\s+(run|test|build)\b|\bair\b/.test(normalized)) return processKinds.go;
  if (/\bbun\b/.test(normalized)) return processKinds.bun;
  if (/\bdeno\b/.test(normalized)) return processKinds.deno;
  if (/\bpnpm\b/.test(normalized)) return processKinds.pnpm;
  if (/\byarn\b/.test(normalized)) return processKinds.yarn;
  if (/\bnpm\b/.test(normalized)) return processKinds.npm;
  if (/\bnode\b/.test(normalized)) return processKinds.node;

  return processKinds.generic;
}

const processKinds: Record<ProcessKind, ProcessKindInfo> = {
  bun: { kind: "bun", label: "Bun" },
  cargo: { kind: "cargo", label: "Cargo" },
  deno: { kind: "deno", label: "Deno" },
  dotnet: { kind: "dotnet", label: ".NET" },
  docker: { kind: "docker", label: "Docker" },
  generic: { kind: "generic", label: "Process" },
  go: { kind: "go", label: "Go" },
  node: { kind: "node", label: "Node" },
  npm: { kind: "npm", label: "npm" },
  pnpm: { kind: "pnpm", label: "pnpm" },
  python: { kind: "python", label: "Python" },
  rust: { kind: "rust", label: "Rust" },
  vite: { kind: "vite", label: "Vite" },
  yarn: { kind: "yarn", label: "Yarn" },
};
