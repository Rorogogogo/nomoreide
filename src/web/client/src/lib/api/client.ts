export interface PortConflictDetail {
  code: "PORT_IN_USE";
  port: number;
  holder: { pid: number; pgid?: number; command: string } | null;
}

export class PortConflictResponseError extends Error {
  readonly conflict: PortConflictDetail;
  constructor(message: string, conflict: PortConflictDetail) {
    super(message);
    this.name = "PortConflictResponseError";
    this.conflict = conflict;
  }
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    if (response.status === 409 && body?.conflict?.code === "PORT_IN_USE") {
      throw new PortConflictResponseError(
        body?.error || "Port already in use",
        body.conflict as PortConflictDetail,
      );
    }
    throw new Error(body?.error || response.statusText);
  }
  return body as T;
}

export async function postForm(
  url: string,
  values: Record<string, string | number | undefined>,
): Promise<void> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && String(value).trim()) {
      body.set(key, String(value));
    }
  }

  await requestJson(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

export async function postFormForJson<T>(
  url: string,
  values: Record<string, string | number | undefined>,
): Promise<T> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && String(value).trim()) {
      body.set(key, String(value));
    }
  }

  return requestJson<T>(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}
