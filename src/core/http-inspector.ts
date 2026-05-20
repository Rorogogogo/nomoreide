import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

export interface HttpInspectorEvent {
  id: string;
  startedAt: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  reqBytes: number;
  resBytes: number;
}

export interface HttpInspectorHandle {
  port: number;
  stop(): Promise<void>;
}

export interface StartInspectorOptions {
  upstreamPort: number;
  upstreamHost?: string;
  onEvent: (event: HttpInspectorEvent) => void;
}

export async function startHttpInspector(
  options: StartInspectorOptions,
): Promise<HttpInspectorHandle> {
  const upstreamHost = options.upstreamHost ?? "127.0.0.1";
  const server: Server = createServer((clientReq, clientRes) => {
    handleRequest(clientReq, clientRes, upstreamHost, options.upstreamPort, options.onEvent);
  });

  server.on("upgrade", (clientReq, clientSocket, head) => {
    handleUpgrade(clientReq, clientSocket as Socket, head, upstreamHost, options.upstreamPort);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    async stop() {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

function handleRequest(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  upstreamHost: string,
  upstreamPort: number,
  onEvent: (event: HttpInspectorEvent) => void,
): void {
  const startedAt = new Date();
  const startTime = process.hrtime.bigint();
  const id = randomUUID();
  let reqBytes = 0;
  let resBytes = 0;

  clientReq.on("data", (chunk: Buffer) => {
    reqBytes += chunk.length;
  });

  const upstream = httpRequest(
    {
      host: upstreamHost,
      port: upstreamPort,
      method: clientReq.method,
      path: clientReq.url,
      headers: rewriteHeaders(clientReq.headers, upstreamHost, upstreamPort),
    },
    (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.on("data", (chunk: Buffer) => {
        resBytes += chunk.length;
      });
      upstreamRes.pipe(clientRes);
      upstreamRes.on("end", () => {
        const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
        onEvent({
          id,
          startedAt: startedAt.toISOString(),
          method: clientReq.method ?? "GET",
          path: clientReq.url ?? "/",
          status: upstreamRes.statusCode ?? 0,
          durationMs: Math.round(durationMs * 10) / 10,
          reqBytes,
          resBytes,
        });
      });
    },
  );

  upstream.on("error", (error) => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "content-type": "text/plain" });
      clientRes.end(`Inspector upstream error: ${error.message}`);
    } else {
      clientRes.end();
    }
    const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
    onEvent({
      id,
      startedAt: startedAt.toISOString(),
      method: clientReq.method ?? "GET",
      path: clientReq.url ?? "/",
      status: 502,
      durationMs: Math.round(durationMs * 10) / 10,
      reqBytes,
      resBytes,
    });
  });

  clientReq.pipe(upstream);
}

function handleUpgrade(
  clientReq: IncomingMessage,
  clientSocket: Socket,
  head: Buffer,
  upstreamHost: string,
  upstreamPort: number,
): void {
  const upstreamSocket = netConnect({ host: upstreamHost, port: upstreamPort });
  upstreamSocket.on("connect", () => {
    const requestLine = `${clientReq.method} ${clientReq.url} HTTP/${clientReq.httpVersion}\r\n`;
    const headerLines = Object.entries(
      rewriteHeaders(clientReq.headers, upstreamHost, upstreamPort),
    )
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`)
      .join("");
    upstreamSocket.write(`${requestLine}${headerLines}\r\n`);
    if (head && head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });
  upstreamSocket.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstreamSocket.destroy());
}

function rewriteHeaders(
  headers: IncomingMessage["headers"],
  upstreamHost: string,
  upstreamPort: number,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = { ...headers };
  out.host = `${upstreamHost}:${upstreamPort}`;
  return out;
}
