export interface DesktopRuntimeConnection {
  apiBaseUrl: string;
  credential: string;
}

declare global {
  interface Window {
    __NOMOREIDE_DESKTOP__?: DesktopRuntimeConnection;
  }
}

function connection(): DesktopRuntimeConnection | undefined {
  if (typeof window === "undefined") return undefined;
  return window.__NOMOREIDE_DESKTOP__;
}

function isDaemonApi(url: string, runtime: DesktopRuntimeConnection): boolean {
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
