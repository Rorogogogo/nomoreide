/**
 * Onboard API surface — the single contract both backends implement (clone+scan
 * a repo URL, register the confirmed proposal, stream the one-shot install).
 * See {@link ../git-api} for the shared-interface seam rationale.
 */

export type OnboardConfidence = "high" | "medium" | "low";

export interface OnboardProposal {
  name: string;
  kind: "local" | "docker-compose";
  command?: string;
  cwd: string;
  port?: number;
  env?: Record<string, string>;
  description?: string;
  composeFile?: string;
  composeService?: string;
  /** One-shot install step to run before the first start (not persisted). */
  installCommand?: string;
  confidence: OnboardConfidence;
  reason: string;
}

export interface OnboardProfile {
  name: string;
  clonePath: string;
  languages: string[];
  node?: {
    packageManager: string;
    scripts: Record<string, string>;
    hasDevScript: boolean;
    hasStartScript: boolean;
  };
  python?: {
    hasRequirements: boolean;
    hasPyproject: boolean;
    hasManagePy: boolean;
    framework: string;
  };
  docker?: { hasDockerfile: boolean; composeFile?: string; composeServices: string[] };
  envKeys: string[];
  readmeExcerpt?: string;
}

export interface OnboardDatabaseProposal {
  name: string;
  engine: "postgres" | "mysql";
  url: string;
  composeService?: string;
  confidence: OnboardConfidence;
  reason: string;
}

export interface OnboardScanResult {
  profile: OnboardProfile;
  proposals: OnboardProposal[];
  databases: OnboardDatabaseProposal[];
}

export interface InstallStreamHandlers {
  onLine: (line: { stream: "stdout" | "stderr"; text: string }) => void;
  onDone: (exitCode: number | null) => void;
  onError: (message: string) => void;
}

export interface OnboardApi {
  /** Clone + scan a repo URL and return its profile plus heuristic proposals. */
  scanRepo(url: string): Promise<OnboardScanResult>;
  /** Register a confirmed proposal as a service, optionally starting it. */
  registerOnboarded(
    proposal: OnboardProposal,
    start: boolean,
    database?: OnboardDatabaseProposal,
  ): Promise<void>;
  /** Stream a one-shot install command's output to the given handlers. */
  streamInstall(
    params: { clonePath: string; command: string },
    handlers: InstallStreamHandlers,
  ): Promise<void>;
}
