import { requestJson } from "./client.js";

export interface JetBrainsRunCandidate {
  id: string;
  name: string;
  runType: string;
  source: string;
  command: string;
  args?: string[];
  cwd: string;
  envKeys: string[];
  conflict: boolean;
}

export interface UnsupportedJetBrainsRun {
  name: string;
  runType: string;
  source: string;
  reason: string;
}

export interface JetBrainsImportPreview {
  sessionId: string;
  projectRoot: string;
  candidates: JetBrainsRunCandidate[];
  unsupported: UnsupportedJetBrainsRun[];
  databases: JetBrainsDatabaseCandidate[];
  unsupportedDatabases: UnsupportedJetBrainsDatabase[];
  expiresAt: string;
}

export interface JetBrainsDatabaseCandidate {
  id: string;
  name: string;
  engine: "postgres" | "mysql" | "sqlite";
  source: string;
  host?: string;
  port?: number;
  database?: string;
  path?: string;
  username?: string;
  conflict: boolean;
}

export interface UnsupportedJetBrainsDatabase {
  name: string;
  source: string;
  reason: string;
}

export interface JetBrainsDatabaseSelection {
  id: string;
  conflict: "add" | "skip" | "replace" | "rename";
  name?: string;
  username?: string;
  password?: string;
  test?: boolean;
}

export interface JetBrainsImportSelection {
  id: string;
  conflict: "add" | "skip" | "replace" | "rename";
  name?: string;
  command?: string;
  args?: string[];
  cwd?: string;
}

export async function scanJetBrainsProject(
  projectRoot: string,
  includePersonal: boolean,
): Promise<JetBrainsImportPreview> {
  const response = await requestJson<{ ok: true; preview: JetBrainsImportPreview }>(
    "/api/import/jetbrains/scan",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot, includePersonal }),
    },
  );
  return response.preview;
}

export async function applyJetBrainsImport(
  sessionId: string,
  selections: JetBrainsImportSelection[],
  databases: JetBrainsDatabaseSelection[] = [],
): Promise<{ services: string[]; databases: string[] }> {
  const response = await requestJson<{
    ok: true;
    imported: string[];
    importedDatabases: string[];
  }>(
    "/api/import/jetbrains/apply",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, selections, databases }),
    },
  );
  return { services: response.imported, databases: response.importedDatabases };
}
