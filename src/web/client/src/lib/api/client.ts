import { beginApiRequest } from "@/lib/api-activity";

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

/**
 * What to show when the server failed without sending an `error` body.
 *
 * The bare `statusText` ("Not Found") names no request, so it reads as a
 * mystery wherever it surfaces. A 404 on an `/api/*` path has one overwhelming
 * cause worth naming outright: the daemon is older than the build and does not
 * have the route yet — server changes need `nomoreide daemon restart`.
 */
function describeFailure(response: Response, url: string, init?: RequestInit): string {
  const method = init?.method?.toUpperCase() ?? "GET";
  const path = url.split("?")[0];
  if (response.status === 404 && path.startsWith("/api/")) {
    return `${method} ${path} is not available on the running NoMoreIDE daemon. It is likely out of date — restart it with \`nomoreide daemon restart\`.`;
  }
  const status = [response.status, response.statusText].filter(Boolean).join(" ");
  return `${method} ${path} failed (${status}).`;
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  // Every web-path API call funnels through here, which is what lets the header
  // Refresh icon spin for any in-flight work. `finally` so a thrown request
  // still releases its slot.
  const settled = beginApiRequest();
  try {
    const response = await fetch(url, init);
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      if (response.status === 409 && body?.conflict?.code === "PORT_IN_USE") {
        throw new PortConflictResponseError(
          body?.error || "Port already in use",
          body.conflict as PortConflictDetail,
        );
      }
      throw new Error(body?.error || describeFailure(response, url, init));
    }
    return body as T;
  } finally {
    settled();
  }
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
