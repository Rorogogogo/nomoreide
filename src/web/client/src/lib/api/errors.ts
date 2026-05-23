import { requestJson } from "./client.js";

export type IncidentLevel = "error" | "warning";

export interface ErrorIncident {
  id: number;
  service: string;
  level: IncidentLevel;
  signature: string;
  title: string;
  file?: string;
  line?: number;
  firstSeen: string;
  lastSeen: string;
  count: number;
  logExcerpt: string[];
}

export interface ErrorIncidentPrompt {
  incident: ErrorIncident;
  file?: string;
  prompt: string;
}

export async function getErrorIncidents(limit = 100): Promise<ErrorIncident[]> {
  const response = await requestJson<{ ok: true; incidents: ErrorIncident[] }>(
    `/api/errors?limit=${limit}`,
  );
  return response.incidents;
}

export async function getErrorPrompt(id: number): Promise<ErrorIncidentPrompt> {
  return requestJson<{ ok: true } & ErrorIncidentPrompt>(`/api/errors/${id}/prompt`);
}
