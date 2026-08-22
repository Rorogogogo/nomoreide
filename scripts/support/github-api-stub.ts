/**
 * A loopback stand-in for api.github.com, so the GitHub tools can be diffed
 * without a token, a network, or a repository that really exists.
 *
 * Each runtime gets its own instance. That keeps the two request logs apart
 * while the gate still runs both runtimes concurrently, and it means the gate
 * compares not only what a tool reported but what it asked for — the method,
 * the path and query, the headers, and the body. A runtime that built the query
 * differently would otherwise only be visible as a 404.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubRoute {
  method: string;
  /** Exact path *and* query, as GitHub would see it. */
  path: string;
  /** Match only requests asking for this media type. Absent matches any. */
  accept?: string;
  status?: number;
  contentType?: string;
  /** JSON body, or the literal text when `contentType` is not JSON. */
  body?: unknown;
}

export interface RecordedRequest {
  method: string;
  path: string;
  accept: string | null;
  authorization: string | null;
  contentType: string | null;
  apiVersion: string | null;
  /** Parsed JSON when the body was JSON, the raw text otherwise, null when empty. */
  body: unknown;
  matched: boolean;
}

export interface GithubStub {
  /** Base URL to hand a runtime, e.g. `http://127.0.0.1:53312`. */
  base: string;
  /** Everything recorded since the last call, and reset. */
  take(): RecordedRequest[];
  close(): Promise<void>;
}

const NOT_FOUND = { message: "Not Found" };

export async function startGithubStub(routes: StubRoute[]): Promise<GithubStub> {
  let recorded: RecordedRequest[] = [];

  const server: Server = createServer((request, response) => {
    void handle(routes, request, response, recorded);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    take() {
      const taken = recorded;
      recorded = [];
      return taken;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function handle(
  routes: StubRoute[],
  request: IncomingMessage,
  response: ServerResponse,
  recorded: RecordedRequest[],
): Promise<void> {
  const raw = await readBody(request);
  const accept = header(request, "accept");
  const path = request.url ?? "";
  const method = request.method ?? "GET";
  const route = routes.find(
    (candidate) =>
      candidate.method === method &&
      candidate.path === path &&
      (candidate.accept === undefined || candidate.accept === accept),
  );

  recorded.push({
    method,
    path,
    accept,
    authorization: header(request, "authorization"),
    contentType: header(request, "content-type"),
    apiVersion: header(request, "x-github-api-version"),
    body: parseBody(raw),
    matched: route !== undefined,
  });

  const contentType = route?.contentType ?? "application/json";
  const status = route?.status ?? (route ? 200 : 404);
  const body = route === undefined ? JSON.stringify(NOT_FOUND) : serialize(route, contentType);
  response.writeHead(status, { "Content-Type": contentType });
  response.end(body);
}

function serialize(route: StubRoute, contentType: string): string {
  if (route.body === undefined) return "";
  if (contentType.includes("json")) return JSON.stringify(route.body);
  return String(route.body);
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function parseBody(raw: string): unknown {
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
