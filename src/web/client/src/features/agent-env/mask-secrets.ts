/**
 * Display-only masking for agent settings files. Matches string values whose
 * key looks secret-bearing (token/key/secret/password/credential) in both
 * JSON (`"KEY": "value"`) and TOML (`KEY = "value"`) shapes. The mask is never
 * written back — the editor only saves the unmasked original.
 */
const SECRET_KEY = /token|key|secret|password|credential/i;

export const SECRET_MASK = "••••••••";

export function maskSecrets(text: string): string {
  return text
    .replace(
      /"([^"\n]+)"(\s*:\s*)"((?:[^"\\\n]|\\.)*)"/g,
      (full, key: string, sep: string, value: string) =>
        SECRET_KEY.test(key) && value ? `"${key}"${sep}"${SECRET_MASK}"` : full,
    )
    .replace(
      /^(\s*)([A-Za-z0-9_.-]+)(\s*=\s*)"((?:[^"\\\n]|\\.)*)"/gm,
      (full, ws: string, key: string, sep: string, value: string) =>
        SECRET_KEY.test(key) && value ? `${ws}${key}${sep}"${SECRET_MASK}"` : full,
    );
}
