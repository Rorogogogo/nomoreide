interface DaemonConnection {
  apiBaseUrl: string;
  credential: string;
}

declare global {
  interface Window {
    /** Injected by the daemon's shell route; carries no base URL because the
     * page is served by the very daemon it calls. */
    __NOMOREIDE_WEB__?: { credential: string };
  }
}

/**
 * Where the API is and what authorises it.
 *
 * The page is always served *by* the daemon — in a browser, or in the
 * `nomoreide menubar` window, which loads the same page — so the origin is
 * already right and only the credential, which the shell route injects, is
 * missing.
 *
 * Without it every `/api/*` call answers `401 Authentication required` —
 * which is exactly what shipped in 0.3.x.
 */
function connection(): DaemonConnection | undefined {
  if (typeof window === "undefined") return undefined;
  const web = window.__NOMOREIDE_WEB__;
  return web ? { apiBaseUrl: window.location.origin, credential: web.credential } : undefined;
}

function isDaemonApi(url: string, runtime: DaemonConnection): boolean {
  if (url.startsWith("/api/")) return true;
  try {
    const candidate = new URL(url);
    const daemon = new URL(runtime.apiBaseUrl);
    return candidate.origin === daemon.origin && candidate.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

export function daemonApiUrl(url: string): string {
  const runtime = connection();
  if (!runtime || !url.startsWith("/api/")) return url;
  return new URL(url, `${runtime.apiBaseUrl}/`).toString();
}

export function daemonRequest(url: string, init?: RequestInit): [string, RequestInit | undefined] {
  const runtime = connection();
  if (!runtime || !isDaemonApi(url, runtime)) return [url, init];

  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${runtime.credential}`);
  return [daemonApiUrl(url), { ...init, headers }];
}

export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const [requestUrl, requestInit] = daemonRequest(url, init);
  return fetch(requestUrl, requestInit);
}

export function daemonWebSocketUrl(path: string, fallback: string): string {
  const runtime = connection();
  if (!runtime) return fallback;
  const url = new URL(path, `${runtime.apiBaseUrl}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function daemonWebSocketProtocols(): string[] | undefined {
  const runtime = connection();
  return runtime ? ["nomoreide", `nomoreide-bearer.${runtime.credential}`] : undefined;
}
