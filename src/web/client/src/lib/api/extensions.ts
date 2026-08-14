import { requestJson } from "./client.js";

/**
 * The Extensions inventory seam.
 *
 * Direct `requestJson` rather than the four-file api/http/tauri/selector split
 * some domains use — the same shape as `servers.ts`, and for the same reason:
 * one read, no Tauri counterpart, and nothing to select between.
 */

export type ExtensionKind = "deploy" | "host";
export type ExtensionSource = "built-in";

export interface InstalledExtension {
  id: string;
  name: string;
  kind: ExtensionKind;
  source: ExtensionSource;
  capabilities: string[];
  actions: string[];
  productionAffecting: string[];
  /** Every host this extension may reach — its manifest's declared egress allowlist. */
  hosts: string[];
  /** Page id where this extension's features appear, or null when it has no page. */
  page: string | null;
}

export async function fetchInstalledExtensions(): Promise<InstalledExtension[]> {
  const res = await requestJson<{ extensions: InstalledExtension[] }>("/api/extensions");
  return res.extensions ?? [];
}
